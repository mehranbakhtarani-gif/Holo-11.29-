/**
 * In-memory operational data-key session.
 *
 * The derived CryptoKey is non-extractable and is never serialized. It is held only
 * while the existing backup session is unlocked; session changes invalidate leases.
 * This module is groundwork only until all operational DB reads/writes use it.
 */
import {
  assertBackupSessionLease,
  captureBackupSessionLease,
} from './backupSession';
import { deriveOperationalDataKey } from './operationalRecordEncryption';
import { initializeOperationalKeyDescriptor, loadOperationalKeyDescriptor } from './operationalDb';
import {
  deriveOperationalKeyFromDescriptor,
  type OperationalKeyDescriptor,
} from './operationalKeyDescriptor';

let activeKey: CryptoKey | null = null;
let generation = 0;

export interface OperationalDataKeyLease {
  key: CryptoKey;
  generation: number;
}

function invalidateOperationalDataKey(): void {
  generation += 1;
  activeKey = null;
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
}

/**
 * Unlock using persisted, versioned workspace KDF metadata.
 * Workspace identity is checked before deriving or exposing a session key.
 */
export async function unlockOperationalDataSessionFromDescriptor(
  descriptor: OperationalKeyDescriptor,
  expectedWorkspaceId: string
): Promise<void> {
  const backupLease = captureBackupSessionLease();
  const requestedGeneration = ++generation;
  activeKey = null;
  const key = await deriveOperationalKeyFromDescriptor(
    backupLease.passphrase,
    descriptor,
    expectedWorkspaceId
  );
  assertBackupSessionLease(backupLease);
  if (requestedGeneration !== generation) {
    throw new Error('Operational key derivation was superseded by another session change.');
  }
  activeKey = key;
}

export function lockOperationalDataSession(): void {
  invalidateOperationalDataKey();
}

export function isOperationalDataSessionUnlocked(): boolean {
  return activeKey !== null;
}

export function captureOperationalDataKeyLease(): OperationalDataKeyLease {
  if (!activeKey) throw new Error('Operational data key is locked.');
  return { key: activeKey, generation };
}

export function assertOperationalDataKeyLease(lease: OperationalDataKeyLease): void {
  if (!activeKey || lease.generation !== generation || lease.key !== activeKey) {
    throw new Error('Operational data-key lease expired; discard the pending operation.');
  }
}


/**
 * Load the persisted workspace envelope (or initialize it once), then unlock
 * the in-memory DEK under the currently active backup-session lease.
 */
export async function unlockOperationalDataSessionForWorkspace(workspaceId: string): Promise<void> {
  let descriptor = await loadOperationalKeyDescriptor(workspaceId);
  if (!descriptor) {
    try {
      descriptor = await initializeOperationalKeyDescriptor(workspaceId);
    } catch (error) {
      // Another tab may have initialized the same workspace concurrently.
      const concurrentlyCreated = await loadOperationalKeyDescriptor(workspaceId);
      if (!concurrentlyCreated) throw error;
      descriptor = concurrentlyCreated;
    }
  }
  await unlockOperationalDataSessionFromDescriptor(descriptor, workspaceId);
}
