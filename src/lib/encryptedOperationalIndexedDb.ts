/**
 * Encrypted IndexedDB transaction primitives for the operational-store cutover.
 *
 * These functions are deliberately opt-in and are not wired to production
 * operationalDb readers/writers. They preserve existing keyPaths, avoid
 * secondary-index leakage, and keep encryption/decryption outside live IDB
 * transactions. The production cutover still requires a coordinated migration.
 */
import {
  decryptOperationalRecord,
  type OperationalEncryptedStore,
} from './operationalRecordEncryption';
import {
  prepareEncryptedOperationalRecordBatch,
  type EncryptedOperationalRow,
  isEncryptedOperationalRow,
} from './encryptedOperationalRecordAdapter';
import {
  assertOperationalDataKeyLease,
  captureOperationalDataKeyLease,
  type OperationalDataKeyLease,
} from './operationalEncryptionSession';

export interface EncryptedOperationalWrite {
  store: OperationalEncryptedStore;
  records: readonly Record<string, unknown>[];
}

export interface EncryptedOperationalQueryOptions {
  /** Maximum number of physical rows to inspect; prevents unbounded decrypt scans. */
  maxScan?: number;
  /** Maximum number of plaintext records returned. */
  limit?: number;
  /** Optional in-memory predicate; never persisted as a plaintext IndexedDB index. */
  predicate?: (record: Record<string, unknown>) => boolean;
}

const MAX_BATCH_RECORDS = 10_000;
const MAX_QUERY_SCAN = 20_000;
const MAX_QUERY_RESULTS = 500;

function assertWorkspaceLease(lease: OperationalDataKeyLease, workspaceId: string): void {
  assertOperationalDataKeyLease(lease);
  if (lease.workspaceId !== workspaceId) {
    throw new Error('Operational data-key lease belongs to a different workspace.');
  }
}

/**
 * Prepare every ciphertext before opening the transaction, then persist all
 * requested stores in one readwrite transaction. Any validation, encryption,
 * lease, quota, or IndexedDB error rejects the whole operation.
 */
export async function writeEncryptedOperationalStoresAtomically(
  db: IDBDatabase,
  workspaceId: string,
  writes: readonly EncryptedOperationalWrite[]
): Promise<number> {
  if (!db || !db.objectStoreNames || !Array.isArray(writes) || writes.length === 0) {
    throw new Error('Encrypted operational transaction input is invalid.');
  }
  const total = writes.reduce((sum, write) => sum + write.records.length, 0);
  if (total > MAX_BATCH_RECORDS) {
    throw new Error('Encrypted operational transaction exceeds the bounded batch size.');
  }
  const storeNames = [...new Set(writes.map((write) => write.store))];
  if (storeNames.length !== writes.length) {
    throw new Error('Each object store may appear only once in an encrypted transaction batch.');
  }
  for (const storeName of storeNames) {
    if (!db.objectStoreNames.contains(storeName)) {
      throw new Error(`Operational object store ${storeName} does not exist.`);
    }
  }

  const lease = captureOperationalDataKeyLease();
  assertWorkspaceLease(lease, workspaceId);
  const prepared: Array<{ store: OperationalEncryptedStore; rows: EncryptedOperationalRow[] }> = [];
  for (const write of writes) {
    assertWorkspaceLease(lease, workspaceId);
    prepared.push({
      store: write.store,
      rows: await prepareEncryptedOperationalRecordBatch(write.store, write.records, workspaceId),
    });
    assertWorkspaceLease(lease, workspaceId);
  }

  return new Promise<number>((resolve, reject) => {
    let tx: IDBTransaction;
    let settled = false;
    let written = 0;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    try {
      assertWorkspaceLease(lease, workspaceId);
      tx = db.transaction(storeNames, 'readwrite');
      for (const batch of prepared) {
        const store = tx.objectStore(batch.store);
        for (const row of batch.rows) {
          assertWorkspaceLease(lease, workspaceId);
          const request = store.put(row);
          request.onsuccess = () => {
            try {
              assertWorkspaceLease(lease, workspaceId);
              written += 1;
            } catch (error) {
              fail(error);
            }
          };
          request.onerror = () => fail(request.error ?? new Error('Encrypted operational row write failed.'));
        }
      }
      tx.oncomplete = () => {
        if (settled) return;
        try {
          assertWorkspaceLease(lease, workspaceId);
          settled = true;
          resolve(written);
        } catch (error) {
          settled = true;
          reject(error);
        }
      };
      tx.onerror = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error('Encrypted operational transaction failed.'));
        }
      };
      tx.onabort = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error('Encrypted operational transaction aborted.'));
        }
      };
    } catch (error) {
      if (typeof tx !== 'undefined') {
        try { tx.abort(); } catch { /* no active transaction */ }
      }
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

/**
 * Decrypt a bounded cursor scan. No business-field IDB indexes are used:
 * date/status/party/SKU lookups are filtered after authenticated decryption.
 * This intentionally trades query throughput for confidentiality until a
 * separately reviewed keyed blind-index design is approved.
 */
export async function queryEncryptedOperationalStore<T extends Record<string, unknown>>(
  db: IDBDatabase,
  storeName: OperationalEncryptedStore,
  workspaceId: string,
  options: EncryptedOperationalQueryOptions = {}
): Promise<{ items: T[]; scanned: number; hasMore: boolean }> {
  if (!db.objectStoreNames.contains(storeName)) {
    throw new Error(`Operational object store ${storeName} does not exist.`);
  }
  const maxScan = Math.max(1, Math.min(MAX_QUERY_SCAN, Math.trunc(options.maxScan ?? 2_000)));
  const limit = Math.max(1, Math.min(MAX_QUERY_RESULTS, Math.trunc(options.limit ?? 100)));
  const lease = captureOperationalDataKeyLease();
  assertWorkspaceLease(lease, workspaceId);

  const cursorResult = await new Promise<{ rows: unknown[]; hasMore: boolean }>((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const result: unknown[] = [];
    const request = tx.objectStore(storeName).openCursor();
    let hasMore = false;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (result.length >= maxScan) {
        hasMore = true;
        return;
      }
      result.push(cursor.value);
      cursor.continue();
    };
    tx.oncomplete = () => resolve({ rows: result, hasMore });
    tx.onerror = () => reject(tx.error ?? new Error('Encrypted operational cursor read failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Encrypted operational cursor read aborted.'));
  });

  const items: T[] = [];
  let scanned = 0;
  for (const row of cursorResult.rows) {
    assertWorkspaceLease(lease, workspaceId);
    if (!isEncryptedOperationalRow(storeName, row, workspaceId)) {
      throw new Error('Plaintext or malformed row encountered in encrypted operational store.');
    }
    const keyField = storeName === 'localProfiles' ? 'workspaceId' : 'id';
    const recordId = (row as Record<string, string>)[keyField];
    const decoded = await decryptOperationalRecord<T>(
      (row as EncryptedOperationalRow).encryptedRecord,
      { workspaceId, store: storeName, recordId },
      lease.key
    );
    assertWorkspaceLease(lease, workspaceId);
    scanned += 1;
    if (!options.predicate || options.predicate(decoded)) {
      items.push(decoded);
      if (items.length >= limit) break;
    }
  }
  return { items, scanned, hasMore: cursorResult.hasMore || scanned < cursorResult.rows.length };
}
