/**
 * Deterministic SHA-256 digests for operational encryption migration verification.
 *
 * The digest is independent of IndexedDB cursor order and JavaScript object insertion
 * order. It binds each canonical record to its logical store and primary key. Callers
 * must compute source and decrypted-target digests over the same logical record set.
 */
import { getOperationalRecordPrimaryKey } from './encryptedOperationalRecordAdapter';
import type { OperationalEncryptedStore } from './operationalRecordEncryption';

function canonicalize(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Migration digest rejects non-finite numbers.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error('Migration digest accepts only JSON-compatible record values.');
  }
  if (seen.has(value)) throw new Error('Migration digest rejects cyclic records.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return '[' + value.map((item) => canonicalize(item, seen)).join(',') + ']';
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Migration digest rejects non-plain record objects.');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(record[key], seen)).join(',') + '}';
  } finally {
    seen.delete(value);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash a complete logical store snapshot. Records are sorted by their IndexedDB
 * primary key, duplicate keys are rejected, and the domain separator prevents
 * cross-store digest reuse. No plaintext is persisted by this function.
 */
export async function computeOperationalMigrationDigest(
  storeName: OperationalEncryptedStore,
  records: readonly Record<string, unknown>[]
): Promise<string> {
  if (!Array.isArray(records) || records.length > 1_000_000) {
    throw new Error('Operational migration digest record count is invalid.');
  }
  const keyed = records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Operational migration digest encountered a malformed record.');
    }
    return { id: getOperationalRecordPrimaryKey(storeName, record), record };
  }).sort((a, b) => a.id.localeCompare(b.id));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index - 1].id === keyed[index].id) {
      throw new Error('Operational migration digest rejects duplicate primary keys.');
    }
  }
  const payload = canonicalize([
    'holoo-apex-operational-migration-digest-v1',
    storeName,
    keyed.map(({ id, record }) => [id, record]),
  ]);
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is required for migration verification.');
  const bytes = new TextEncoder().encode(payload);
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return toHex(new Uint8Array(digest));
  } finally {
    bytes.fill(0);
  }
}

export interface OperationalMigrationDigestVerification {
  storeName: OperationalEncryptedStore;
  sourceRecordCount: number;
  targetRecordCount: number;
  sourceDigest: string;
  targetDigest: string;
  verified: true;
}

/**
 * Verify an in-memory source snapshot against its decrypted shadow snapshot.
 * This does not persist a checkpoint or authorize cutover; callers must first
 * obtain both complete snapshots under the same source revision and key lease.
 */
export async function verifyOperationalMigrationStoreDigests(
  storeName: OperationalEncryptedStore,
  sourceRecords: readonly Record<string, unknown>[],
  decryptedTargetRecords: readonly Record<string, unknown>[]
): Promise<OperationalMigrationDigestVerification> {
  if (sourceRecords.length !== decryptedTargetRecords.length) {
    throw new Error('Operational migration verification failed: source and target record counts differ.');
  }
  const [sourceDigest, targetDigest] = await Promise.all([
    computeOperationalMigrationDigest(storeName, sourceRecords),
    computeOperationalMigrationDigest(storeName, decryptedTargetRecords),
  ]);
  if (sourceDigest !== targetDigest) {
    throw new Error('Operational migration verification failed: source and target digests differ.');
  }
  return {
    storeName,
    sourceRecordCount: sourceRecords.length,
    targetRecordCount: decryptedTargetRecords.length,
    sourceDigest,
    targetDigest,
    verified: true,
  };
}
