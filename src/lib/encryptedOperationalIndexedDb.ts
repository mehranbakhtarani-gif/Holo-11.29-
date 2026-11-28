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
import {
  advanceOperationalMigrationStoreCheckpoint,
  isValidOperationalMigrationJournalRecord,
  assertOperationalMigrationBinding,
  type OperationalMigrationBinding,
  type OperationalMigrationJournalRecord,
  type OperationalMigrationStoreCheckpoint,
} from './operationalMigrationJournal';

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
    let tx: IDBTransaction | undefined;
    let settled = false;
    let written = 0;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { tx?.abort(); } catch { /* transaction may already be inactive */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    try {
      assertWorkspaceLease(lease, workspaceId);
      const transaction = db.transaction(storeNames, 'readwrite');
      tx = transaction;
      for (const batch of prepared) {
        const store = transaction.objectStore(batch.store);
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
      transaction.oncomplete = () => {
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
      transaction.onerror = () => {
        if (!settled) {
          settled = true;
          reject(transaction.error ?? new Error('Encrypted operational transaction failed.'));
        }
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transaction.error ?? new Error('Encrypted operational transaction aborted.'));
        }
      };
    } catch (error) {
      if (tx) {
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
 * Atomically persist one encrypted migration batch and its durable checkpoint.
 * All ciphertext and the next checkpoint are prepared before the IDB transaction.
 * The current journal is compare-and-swapped inside that transaction; either all
 * target rows and the checkpoint commit, or IndexedDB rolls the entire batch back.
 */
export async function writeEncryptedOperationalMigrationBatchAtomically(
  db: IDBDatabase,
  workspaceId: string,
  writes: readonly EncryptedOperationalWrite[],
  expectedJournal: OperationalMigrationJournalRecord,
  binding: OperationalMigrationBinding,
  checkpoint: Omit<OperationalMigrationStoreCheckpoint, 'storeName'> & { storeName: string }
): Promise<{ written: number; journal: OperationalMigrationJournalRecord }> {
  const journalStoreName = 'operationalMigrationJournal';
  if (!db || !db.objectStoreNames || !Array.isArray(writes) || writes.length === 0 ||
      !db.objectStoreNames.contains(journalStoreName)) {
    throw new Error('Encrypted migration transaction input or journal store is invalid.');
  }
  if (!isValidOperationalMigrationJournalRecord(expectedJournal)) {
    throw new Error('Expected operational migration journal is invalid.');
  }
  assertOperationalMigrationBinding(expectedJournal, binding);
  if (expectedJournal.phase !== 'copying') {
    throw new Error('Encrypted migration batches are permitted only during the copying phase.');
  }
  const total = writes.reduce((sum, write) => sum + write.records.length, 0);
  if (total > MAX_BATCH_RECORDS) {
    throw new Error('Encrypted migration batch exceeds the bounded record count.');
  }
  const storeNames = [...new Set(writes.map((write) => write.store))];
  if (storeNames.length !== writes.length || storeNames.includes(journalStoreName as OperationalEncryptedStore)) {
    throw new Error('Migration batch contains duplicate or reserved object stores.');
  }
  for (const storeName of storeNames) {
    if (!db.objectStoreNames.contains(storeName)) {
      throw new Error(`Operational object store ${storeName} does not exist.`);
    }
  }

  const lease = captureOperationalDataKeyLease();
  assertWorkspaceLease(lease, workspaceId);
  if (lease.backupSessionGeneration !== binding.backupSessionGeneration ||
      binding.workspaceId !== workspaceId) {
    throw new Error('Migration batch is bound to another workspace or backup session.');
  }
  const prepared: Array<{ store: OperationalEncryptedStore; rows: EncryptedOperationalRow[] }> = [];
  for (const write of writes) {
    assertWorkspaceLease(lease, workspaceId);
    prepared.push({
      store: write.store,
      rows: await prepareEncryptedOperationalRecordBatch(write.store, write.records, workspaceId),
    });
    assertWorkspaceLease(lease, workspaceId);
  }
  const nextJournal = advanceOperationalMigrationStoreCheckpoint(
    expectedJournal,
    checkpoint.storeName,
    checkpoint,
    binding
  );
  if (!isValidOperationalMigrationJournalRecord(nextJournal)) {
    throw new Error('Prepared migration checkpoint failed validation.');
  }

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | undefined;
    let settled = false;
    let written = 0;
    const cleanup = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('holoo:backup-session-changed', abortOnSessionChange);
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { tx?.abort(); } catch { /* transaction may already be inactive */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const abortOnSessionChange = () => {
      try { assertWorkspaceLease(lease, workspaceId); }
      catch (error) { fail(error); }
    };
    try {
      assertWorkspaceLease(lease, workspaceId);
      tx = db.transaction([...storeNames, journalStoreName], 'readwrite');
      if (typeof window !== 'undefined') {
        window.addEventListener('holoo:backup-session-changed', abortOnSessionChange);
      }
      const journalStore = tx.objectStore(journalStoreName);
      const journalRequest = journalStore.get(binding.migrationId);
      journalRequest.onsuccess = () => {
        try {
          assertWorkspaceLease(lease, workspaceId);
          const current = journalRequest.result as unknown;
          if (!isValidOperationalMigrationJournalRecord(current) ||
              JSON.stringify(current) !== JSON.stringify(expectedJournal)) {
            throw new Error('Operational migration journal changed; stale batch was rejected.');
          }
          assertOperationalMigrationBinding(current, binding);
          for (const batch of prepared) {
            const target = tx!.objectStore(batch.store);
            for (const row of batch.rows) {
              assertWorkspaceLease(lease, workspaceId);
              const request = target.put(row);
              request.onsuccess = () => {
                try { assertWorkspaceLease(lease, workspaceId); written += 1; }
                catch (error) { fail(error); }
              };
              request.onerror = () => fail(request.error ?? new Error('Encrypted migration row write failed.'));
            }
          }
          assertWorkspaceLease(lease, workspaceId);
          journalStore.put(nextJournal);
        } catch (error) { fail(error); }
      };
      journalRequest.onerror = () => fail(journalRequest.error ?? new Error('Migration journal compare-and-swap read failed.'));
      tx.oncomplete = () => {
        if (settled) return;
        try {
          assertWorkspaceLease(lease, workspaceId);
          settled = true;
          cleanup();
          resolve({ written, journal: nextJournal });
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      tx.onerror = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(tx?.error ?? new Error('Encrypted migration transaction failed.'));
        }
      };
      tx.onabort = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(tx?.error ?? new Error('Encrypted migration transaction aborted.'));
        }
      };
    } catch (error) {
      fail(error);
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
    const recordId = (row as unknown as Record<string, unknown>)[keyField];
    if (typeof recordId !== 'string' || recordId.length === 0) {
      throw new Error('Encrypted operational row has an invalid primary key.');
    }
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
