/**
 * In-memory operational data-key session.
 *
 * The derived CryptoKey is non-extractable and is never serialized. It is held only
 * while the existing backup session is unlocked; session changes invalidate leases.
 * This module is groundwork only until all operational DB reads/writes use it.
 */
import {
  assertBackupSessionLease,
  assertBackupSessionGeneration,
  captureBackupSessionLease,
} from './backupSession';
import { deriveOperationalDataKey } from './operationalRecordEncryption';
import {
  initializeOperationalKeyDescriptor,
  isOperationalRestoreBarrierActive,
  loadOperationalKeyDescriptor,
  rewrapOperationalKeyDescriptorForWorkspace as rewrapOperationalKeyDescriptor,
} from './operationalDb';
import {
  deriveOperationalKeyFromDescriptor,
  type OperationalKeyDescriptor,
} from './operationalKeyDescriptor';

let activeKey: CryptoKey | null = null;
let activeWorkspaceId: string | null = null;
let activeBackupSessionGeneration: number | null = null;
let generation = 0;

export interface OperationalDataKeyLease {
  key: CryptoKey;
  generation: number;
  workspaceId: string | null;
  backupSessionGeneration: number;
}

function invalidateOperationalDataKey(): void {
  generation += 1;
  activeKey = null;
  activeWorkspaceId = null;
  activeBackupSessionGeneration = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('holoo:backup-session-changed', invalidateOperationalDataKey);
}

/** Derive the operational key once after the backup session has been unlocked. */
export async function unlockOperationalDataSession(salt: Uint8Array): Promise<void> {
  const backupLease = captureBackupSessionLease();
  const requestedGeneration = ++generation;
  activeKey = null;
  const key = await deriveOperationalDataKey(backupLease.passphrase, salt);
  assertBackupSessionLease(backupLease);
  if (requestedGeneration !== generation) {
    throw new Error('Operational key derivation was superseded by another session change.');
  }
  activeKey = key;
  activeWorkspaceId = null;
  activeBackupSessionGeneration = backupLease.generation;
}

/**
 * Unlock using persisted, versioned workspace KDF metadata.
 * Workspace identity is checked before deriving or exposing a session key.
 */
export async function unlockOperationalDataSessionFromDescriptor(
  descriptor: OperationalKeyDescriptor,
  expectedWorkspaceId: string
): Promise<void> {
  if (isOperationalRestoreBarrierActive()) {
    throw new Error('Operational key unlock is blocked while workspace restore is active.');
  }
  const backupLease = captureBackupSessionLease();
  const requestedGeneration = ++generation;
  activeKey = null;
  const key = await deriveOperationalKeyFromDescriptor(
    backupLease.passphrase,
    descriptor,
    expectedWorkspaceId
  );
  assertBackupSessionLease(backupLease);
  if (isOperationalRestoreBarrierActive()) {
    throw new Error('Workspace restore started while the operational key was being unlocked.');
  }
  if (requestedGeneration !== generation) {
    throw new Error('Operational key derivation was superseded by another session change.');
  }
  activeKey = key;
  activeWorkspaceId = expectedWorkspaceId;
  activeBackupSessionGeneration = backupLease.generation;
}

export function lockOperationalDataSession(): void {
  invalidateOperationalDataKey();
}

export function isOperationalDataSessionUnlocked(): boolean {
  return activeKey !== null;
}

export function captureOperationalDataKeyLease(): OperationalDataKeyLease {
  if (isOperationalRestoreBarrierActive()) {
    throw new Error('Operational data access is blocked while workspace restore is active.');
  }
  if (!activeKey || activeBackupSessionGeneration === null) {
    throw new Error('Operational data key is locked.');
  }
  return {
    key: activeKey,
    generation,
    workspaceId: activeWorkspaceId,
    backupSessionGeneration: activeBackupSessionGeneration,
  };
}

export function assertOperationalDataKeyLease(lease: OperationalDataKeyLease): void {
  if (isOperationalRestoreBarrierActive()) {
    throw new Error('Operational data access is blocked while workspace restore is active.');
  }
  try {
    assertBackupSessionGeneration(lease.backupSessionGeneration);
  } catch {
    throw new Error('Operational data-key lease expired; discard the pending operation.');
  }
  if (
    !activeKey || lease.generation !== generation || lease.key !== activeKey ||
    lease.workspaceId !== activeWorkspaceId ||
    lease.backupSessionGeneration !== activeBackupSessionGeneration
  ) {
    throw new Error('Operational data-key lease expired; discard the pending operation.');
  }
}


/**
 * Load the persisted workspace envelope (or initialize it once), then unlock
 * the in-memory DEK under the currently active backup-session lease.
 */
export async function unlockOperationalDataSessionForWorkspace(workspaceId: string): Promise<void> {
  const cleanWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!cleanWorkspaceId || cleanWorkspaceId.length > 180) {
    throw new Error('Operational key workspace identity is invalid.');
  }
  if (isOperationalRestoreBarrierActive()) {
    throw new Error('Operational key unlock is blocked while workspace restore is active.');
  }

  // Fence the entire asynchronous bootstrap, not just the final KDF. A workspace
  // switch can happen while IndexedDB is loading/initializing the descriptor; a
  // stale request must never supersede the newer workspace's in-memory key.
  const backupLease = captureBackupSessionLease();
  const requestedGeneration = ++generation;
  activeKey = null;
  activeWorkspaceId = null;

  const assertRequestIsCurrent = () => {
    assertBackupSessionLease(backupLease);
    if (requestedGeneration !== generation) {
      throw new Error('Operational key derivation was superseded by another session change.');
    }
    if (isOperationalRestoreBarrierActive()) {
      throw new Error('Operational key unlock is blocked while workspace restore is active.');
    }
  };

  assertRequestIsCurrent();
  let descriptor = await loadOperationalKeyDescriptor(cleanWorkspaceId);
  assertRequestIsCurrent();

  if (!descriptor) {
    try {
      descriptor = await initializeOperationalKeyDescriptor(cleanWorkspaceId);
    } catch (error) {
      // Another tab may have initialized the same workspace concurrently.
      assertRequestIsCurrent();
      const concurrentlyCreated = await loadOperationalKeyDescriptor(cleanWorkspaceId);
      assertRequestIsCurrent();
      if (!concurrentlyCreated) throw error;
      descriptor = concurrentlyCreated;
    }
  }

  assertRequestIsCurrent();
  if (!descriptor || descriptor.workspaceId !== cleanWorkspaceId) {
    throw new Error('Operational key descriptor is invalid or belongs to another workspace.');
  }

  const key = await deriveOperationalKeyFromDescriptor(
    backupLease.passphrase,
    descriptor,
    cleanWorkspaceId
  );
  assertRequestIsCurrent();
  activeKey = key;
  activeWorkspaceId = cleanWorkspaceId;
  activeBackupSessionGeneration = backupLease.generation;
}

/**
 * Re-wrap the durable workspace DEK envelope using the current backup-session
 * lease. The context layer depends only on this session boundary, not IndexedDB.
 */
export async function rewrapOperationalWorkspaceKey(
  workspaceId: string,
  nextPassphrase: string
): Promise<OperationalKeyDescriptor> {
  const lease = captureBackupSessionLease();
  const requestedGeneration = generation;
  const descriptor = await rewrapOperationalKeyDescriptor(workspaceId, nextPassphrase);
  assertBackupSessionLease(lease);
  if (requestedGeneration !== generation) {
    throw new Error('Operational key rotation was superseded by another session change.');
  }
  return descriptor;
}
