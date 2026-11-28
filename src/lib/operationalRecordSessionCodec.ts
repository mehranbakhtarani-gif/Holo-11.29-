/**
 * Session-bound record codec.
 *
 * Every operation captures the current in-memory key lease and checks it both
 * before and after Web Crypto. A lock or workspace/session replacement during
 * an asynchronous operation therefore prevents stale ciphertext from being
 * persisted and prevents decrypted plaintext from being returned to callers.
 * This wrapper is intentionally not wired into IndexedDB until the complete
 * primary-store migration can switch all readers and writers atomically.
 */
import {
  decryptOperationalRecord,
  encryptOperationalRecord,
  type OperationalRecordContext,
  type OperationalRecordEnvelope,
} from './operationalRecordEncryption';
import {
  assertOperationalDataKeyLease,
  captureOperationalDataKeyLease,
} from './operationalEncryptionSession';

export async function encryptOperationalRecordForActiveSession<T>(
  value: T,
  context: OperationalRecordContext
): Promise<OperationalRecordEnvelope> {
  const lease = captureOperationalDataKeyLease();
  assertOperationalDataKeyLease(lease);
  if (lease.workspaceId !== context.workspaceId) {
    throw new Error('Operational record workspace does not match the active key session.');
  }
  const envelope = await encryptOperationalRecord(value, context, lease.key);
  assertOperationalDataKeyLease(lease);
  return envelope;
}

export async function decryptOperationalRecordForActiveSession<T>(
  envelope: OperationalRecordEnvelope,
  expectedContext: OperationalRecordContext
): Promise<T> {
  const lease = captureOperationalDataKeyLease();
  assertOperationalDataKeyLease(lease);
  if (lease.workspaceId !== expectedContext.workspaceId) {
    throw new Error('Operational record workspace does not match the active key session.');
  }
  const value = await decryptOperationalRecord<T>(envelope, expectedContext, lease.key);
  assertOperationalDataKeyLease(lease);
  return value;
}
