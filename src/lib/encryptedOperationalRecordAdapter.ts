/**
 * Primary-key-preserving encrypted row adapter.
 *
 * This adapter is intentionally not connected to operationalDb. Callers must
 * prepare every row in a multi-store operation before opening the IndexedDB
 * write transaction, then write the returned wrappers in one transaction.
 * The current DB schema/readers remain authoritative until a complete,
 * restartable migration and rollback path is ready.
 */
import {
  decryptOperationalRecord,
  encryptOperationalRecord,
  type OperationalEncryptedStore,
  type OperationalRecordEnvelope,
} from './operationalRecordEncryption';
import {
  assertOperationalDataKeyLease,
  captureOperationalDataKeyLease,
  type OperationalDataKeyLease,
} from './operationalEncryptionSession';

export type OperationalEncryptedPrimaryKeyField = 'id' | 'workspaceId';

const PRIMARY_KEY_FIELDS: Record<OperationalEncryptedStore, OperationalEncryptedPrimaryKeyField> = {
  accounts: 'id',
  parties: 'id',
  products: 'id',
  vouchers: 'id',
  invoices: 'id',
  cheques: 'id',
  employees: 'id',
  assets: 'id',
  costCenters: 'id',
  currencies: 'id',
  exchangeRates: 'id',
  importDossiers: 'id',
  salesOrders: 'id',
  subcontractJobs: 'id',
  rbacOperators: 'id',
  auditLogs: 'id',
  warehouses: 'id',
  taxReports: 'id',
  localProfiles: 'workspaceId',
};

export type EncryptedOperationalRow =
  { encryptedRecord: OperationalRecordEnvelope } &
  Partial<Record<OperationalEncryptedPrimaryKeyField, string>>;

export function getOperationalRecordPrimaryKey(
  store: OperationalEncryptedStore,
  record: unknown
): string {
  const field = PRIMARY_KEY_FIELDS[store];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Operational record must be a keyed object.');
  }
  const value = (record as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`Operational ${store} record is missing its IndexedDB ${field} key.`);
  }
  return value;
}

/** Reject accidental plaintext or mixed rows before any consumer can decode them. */
export function isEncryptedOperationalRow(
  store: OperationalEncryptedStore,
  value: unknown,
  workspaceId: string
): value is EncryptedOperationalRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keyField = PRIMARY_KEY_FIELDS[store];
  const envelope = row.encryptedRecord as Partial<OperationalRecordEnvelope> | undefined;
  const allowedKeys = new Set([keyField, 'encryptedRecord']);
  if (Object.keys(row).some((key) => !allowedKeys.has(key))) return false;
  return typeof row[keyField] === 'string' &&
    Boolean((row[keyField] as string).trim()) &&
    Boolean(envelope) &&
    envelope?.format === 'holoo-apex-operational-record' &&
    envelope.version === 1 &&
    envelope.workspaceId === workspaceId &&
    envelope.store === store &&
    envelope.recordId === row[keyField] &&
    envelope.cipher === 'AES-256-GCM' &&
    typeof envelope.ivB64 === 'string' &&
    typeof envelope.ciphertextB64 === 'string';
}

function assertLeaseForWorkspace(lease: OperationalDataKeyLease, workspaceId: string): void {
  assertOperationalDataKeyLease(lease);
  if (lease.workspaceId !== workspaceId) {
    throw new Error('Operational data-key lease belongs to a different workspace.');
  }
}

/**
 * Encrypt a complete batch before any IndexedDB transaction begins.
 * If any row fails or the key lease expires, no rows are returned to the caller.
 */
export async function prepareEncryptedOperationalRecordBatch(
  store: OperationalEncryptedStore,
  records: readonly Record<string, unknown>[],
  workspaceId: string
): Promise<EncryptedOperationalRow[]> {
  if (!Array.isArray(records) || records.length > 10_000) {
    throw new Error('Operational encrypted record batch size is invalid.');
  }
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 180) {
    throw new Error('Operational encrypted record workspace identity is invalid.');
  }
  const lease = captureOperationalDataKeyLease();
  assertLeaseForWorkspace(lease, workspaceId);
  const prepared: EncryptedOperationalRow[] = [];
  const seenRecordIds = new Set<string>();
  const keyField = PRIMARY_KEY_FIELDS[store];

  for (const record of records) {
    assertLeaseForWorkspace(lease, workspaceId);
    const recordId = getOperationalRecordPrimaryKey(store, record);
    if (seenRecordIds.has(recordId)) {
      throw new Error(`Operational ${store} batch contains duplicate primary key ${recordId}.`);
    }
    seenRecordIds.add(recordId);
    const envelope = await encryptOperationalRecord(record, {
      workspaceId,
      store,
      recordId,
    }, lease.key);
    assertLeaseForWorkspace(lease, workspaceId);
    prepared.push({ [keyField]: recordId, encryptedRecord: envelope } as EncryptedOperationalRow);
  }

  assertLeaseForWorkspace(lease, workspaceId);
  return prepared;
}

/** Decrypt a row only after checking its keyPath wrapper and session generation. */
export async function readEncryptedOperationalRecord<T extends Record<string, unknown>>(
  store: OperationalEncryptedStore,
  row: unknown,
  workspaceId: string
): Promise<T> {
  const lease = captureOperationalDataKeyLease();
  assertLeaseForWorkspace(lease, workspaceId);
  if (!isEncryptedOperationalRow(store, row, workspaceId)) {
    throw new Error('Operational IndexedDB row is not a valid encrypted primary-store record.');
  }
  const keyField = PRIMARY_KEY_FIELDS[store];
  const recordId = row[keyField] as string;
  const record = await decryptOperationalRecord<T>(row.encryptedRecord, {
    workspaceId,
    store,
    recordId,
  }, lease.key);
  assertLeaseForWorkspace(lease, workspaceId);
  if (getOperationalRecordPrimaryKey(store, record) !== recordId) {
    throw new Error('Decrypted operational record primary key does not match its IndexedDB location.');
  }
  return record;
}
