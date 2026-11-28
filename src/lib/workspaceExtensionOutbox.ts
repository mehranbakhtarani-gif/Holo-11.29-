import {
  computeSnapshotSha256Hex,
  decryptAndVerifyBackupEnvelope,
  encryptBackupEnvelope,
} from './offlineFirstCore';
import type { SyncOutboxOperation } from './operationalDb';

export interface WorkspaceExtensionOutboxPayload {
  schemaVersion: 1;
  workspaceId: string;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsUnsafeKeys(value: unknown, depth = 0): boolean {
  if (depth > 40) return true;
  if (Array.isArray(value)) return value.some((item) => containsUnsafeKeys(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    key === '__proto__' || key === 'constructor' || key === 'prototype' ||
    containsUnsafeKeys(child, depth + 1)
  );
}

export async function createEncryptedWorkspaceExtensionOutboxOperation(params: {
  workspaceId: string;
  deviceId: string;
  clientRevision: number;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
  passphrase: string;
  createdAt?: string;
}): Promise<SyncOutboxOperation> {
  if (!params.workspaceId || params.workspaceId.length > 180 ||
      !params.deviceId || params.deviceId.length > 180 ||
      !Number.isSafeInteger(params.clientRevision) || params.clientRevision < 0 ||
      !isRecord(params.previous) || !isRecord(params.next) ||
      containsUnsafeKeys(params.previous) || containsUnsafeKeys(params.next)) {
    throw new Error('Workspace extension outbox payload metadata is invalid.');
  }

  const payload: WorkspaceExtensionOutboxPayload = {
    schemaVersion: 1,
    workspaceId: params.workspaceId,
    previous: params.previous,
    next: params.next,
  };
  const plaintext = JSON.stringify(payload);
  if (new TextEncoder().encode(plaintext).byteLength > 700_000) {
    throw new Error('Workspace extension change is too large for the encrypted offline queue.');
  }

  const payloadHash = await computeSnapshotSha256Hex(plaintext);
  const envelope = await encryptBackupEnvelope(plaintext, params.passphrase);
  const safeWorkspaceId = params.workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return {
    operationId: `workspace_ext_${safeWorkspaceId}_${payloadHash.slice(0, 24)}`,
    target: 'firebase',
    workspaceId: params.workspaceId,
    deviceId: params.deviceId,
    clientRevision: params.clientRevision,
    payloadHash,
    encryptedPayload: JSON.stringify(envelope),
    createdAt: params.createdAt || new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
  };
}

export async function decryptWorkspaceExtensionOutboxOperation(
  operation: SyncOutboxOperation,
  expectedWorkspaceId: string,
  passphrase: string
): Promise<WorkspaceExtensionOutboxPayload | null> {
  if (
    operation.target !== 'firebase' ||
    operation.workspaceId !== expectedWorkspaceId ||
    !operation.operationId.startsWith('workspace_ext_') ||
    typeof operation.encryptedPayload !== 'string' ||
    operation.encryptedPayload.length === 0 ||
    operation.encryptedPayload.length > 1_500_000 ||
    !/^[a-f0-9]{64}$/i.test(operation.payloadHash)
  ) return null;

  const verified = await decryptAndVerifyBackupEnvelope(operation.encryptedPayload, passphrase);
  if (!verified.ok || !verified.snapshotJson || verified.sha256 !== operation.payloadHash) return null;

  try {
    const parsed: unknown = JSON.parse(verified.snapshotJson);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.workspaceId !== expectedWorkspaceId ||
      !isRecord(parsed.previous) ||
      !isRecord(parsed.next) ||
      containsUnsafeKeys(parsed)
    ) return null;

    return parsed as unknown as WorkspaceExtensionOutboxPayload;
  } catch {
    return null;
  }
}
