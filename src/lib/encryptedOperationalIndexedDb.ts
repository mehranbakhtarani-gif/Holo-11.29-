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
  getOperationalRecordPrimaryKey,
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
  /** Migration run identifier; omitted for the non-migration encrypted shadow snapshot. */
  migrationId?: string;
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
const ENCRYPTED_SHADOW_STORE = 'encryptedOperationalRecords';
const DEFAULT_SHADOW_MIGRATION_ID = 'operational-shadow-current';

interface EncryptedOperationalShadowRow {
  workspaceId: string;
  migrationId: string;
  storeName: OperationalEncryptedStore;
  recordId: string;
  encryptedRecord: EncryptedOperationalRow['encryptedRecord'];
}

function toShadowRows(storeName: OperationalEncryptedStore, workspaceId: string, migrationId: string, rows: readonly EncryptedOperationalRow[]): EncryptedOperationalShadowRow[] {
  return rows.map((row) => {
    if (!isEncryptedOperationalRow(storeName, row, workspaceId)) {
      throw new Error('Prepared encrypted operational row failed shadow-store validation.');
    }
    return {
      workspaceId,
      migrationId,
      storeName,
      recordId: getOperationalRecordPrimaryKey(storeName, row),
      encryptedRecord: row.encryptedRecord,
    };
  });
}

function workspaceStoreKeyRange(workspaceId: string, migrationId: string, storeName: OperationalEncryptedStore): IDBKeyRange {
  const keyRange = typeof window !== 'undefined' ? window.IDBKeyRange : globalThis.IDBKeyRange;
  if (!keyRange) throw new Error('IndexedDB key-range support is unavailable.');
  return keyRange.only([workspaceId, migrationId, storeName]);
}

/** Write ciphertext only to the isolated shadow store; source business stores remain untouched. */
export async function writeEncryptedOperationalStoresAtomically(
  db: IDBDatabase,
  workspaceId: string,
  writes: readonly EncryptedOperationalWrite[]
): Promise<number> {
  if (!db || !db.objectStoreNames || !Array.isArray(writes) || writes.length === 0 ||
      !db.objectStoreNames.contains(ENCRYPTED_SHADOW_STORE)) {
    throw new Error('Encrypted operational shadow-store transaction input is invalid.');
  }
  const total = writes.reduce((sum, write) => sum + write.records.length, 0);
  if (total > MAX_BATCH_RECORDS) throw new Error('Encrypted operational transaction exceeds the bounded batch size.');
  const storeNames = [...new Set(writes.map((write) => write.store))];
  if (storeNames.length !== writes.length) throw new Error('Each logical store may appear only once in an encrypted transaction batch.');

  const lease = captureOperationalDataKeyLease();
  assertWorkspaceLease(lease, workspaceId);
  const prepared: EncryptedOperationalShadowRow[] = [];
  for (const write of writes) {
    assertWorkspaceLease(lease, workspaceId);
    const rows = await prepareEncryptedOperationalRecordBatch(write.store, write.records, workspaceId);
    prepared.push(...toShadowRows(write.store, workspaceId, DEFAULT_SHADOW_MIGRATION_ID, rows));
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
      tx = db.transaction([ENCRYPTED_SHADOW_STORE], 'readwrite');
      const target = tx.objectStore(ENCRYPTED_SHADOW_STORE);
      for (const row of prepared) {
        assertWorkspaceLease(lease, workspaceId);
        const request = target.put(row);
        request.onsuccess = () => {
          try { assertWorkspaceLease(lease, workspaceId); written += 1; }
          catch (error) { fail(error); }
        };
        request.onerror = () => fail(request.error ?? new Error('Encrypted operational shadow row write failed.'));
      }
      tx.oncomplete = () => {
        if (settled) return;
        try { assertWorkspaceLease(lease, workspaceId); settled = true; resolve(written); }
        catch (error) { settled = true; reject(error); }
      };
      tx.onerror = () => {
        if (!settled) { settled = true; reject(tx?.error ?? new Error('Encrypted operational shadow transaction failed.')); }
      };
      tx.onabort = () => {
        if (!settled) { settled = true; reject(tx?.error ?? new Error('Encrypted operational shadow transaction aborted.')); }
      };
    } catch (error) { fail(error); }
  });
}

/** Persist ciphertext and the corresponding checkpoint in one shadow+journal transaction. */
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
      !db.objectStoreNames.contains(journalStoreName) || !db.objectStoreNames.contains(ENCRYPTED_SHADOW_STORE)) {
    throw new Error('Encrypted migration transaction input or shadow/journal stores are invalid.');
  }
  if (!isValidOperationalMigrationJournalRecord(expectedJournal)) throw new Error('Expected operational migration journal is invalid.');
  assertOperationalMigrationBinding(expectedJournal, binding);
  if (expectedJournal.phase !== 'copying') throw new Error('Encrypted migration batches are permitted only during the copying phase.');
  const total = writes.reduce((sum, write) => sum + write.records.length, 0);
  if (total > MAX_BATCH_RECORDS) throw new Error('Encrypted migration batch exceeds the bounded record count.');
  const storeNames = [...new Set(writes.map((write) => write.store))];
  if (writes.length !== 1 || storeNames.length !== 1 || storeNames[0] !== checkpoint.storeName) {
    throw new Error('Each atomic migration checkpoint must cover exactly one matching logical store batch.');
  }
  if (!storeNames.includes(checkpoint.storeName as OperationalEncryptedStore)) {
    throw new Error('Migration checkpoint store does not match a store in the encrypted batch.');
  }

  const lease = captureOperationalDataKeyLease();
  assertWorkspaceLease(lease, workspaceId);
  if (lease.backupSessionGeneration !== binding.backupSessionGeneration || binding.workspaceId !== workspaceId) {
    throw new Error('Migration batch is bound to another workspace or backup session.');
  }
  const prepared: EncryptedOperationalShadowRow[] = [];
  for (const write of writes) {
    assertWorkspaceLease(lease, workspaceId);
    const rows = await prepareEncryptedOperationalRecordBatch(write.store, write.records, workspaceId);
    prepared.push(...toShadowRows(write.store, workspaceId, binding.migrationId, rows));
    assertWorkspaceLease(lease, workspaceId);
  }
  const nextJournal = advanceOperationalMigrationStoreCheckpoint(expectedJournal, checkpoint.storeName, checkpoint, binding);
  if (!isValidOperationalMigrationJournalRecord(nextJournal)) throw new Error('Prepared migration checkpoint failed validation.');

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | undefined;
    let settled = false;
    let written = 0;
    const cleanup = () => {
      if (typeof window !== 'undefined') window.removeEventListener('holoo:backup-session-changed', abortOnSessionChange);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { tx?.abort(); } catch { /* transaction may already be inactive */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const abortOnSessionChange = () => {
      try { assertWorkspaceLease(lease, workspaceId); } catch (error) { fail(error); }
    };
    try {
      assertWorkspaceLease(lease, workspaceId);
      tx = db.transaction([ENCRYPTED_SHADOW_STORE, journalStoreName], 'readwrite');
      if (typeof window !== 'undefined') window.addEventListener('holoo:backup-session-changed', abortOnSessionChange);
      const shadowStore = tx.objectStore(ENCRYPTED_SHADOW_STORE);
      const journalStore = tx.objectStore(journalStoreName);
      const journalRequest = journalStore.get(binding.migrationId);
      journalRequest.onsuccess = () => {
        try {
          assertWorkspaceLease(lease, workspaceId);
          const current = journalRequest.result as unknown;
          if (!isValidOperationalMigrationJournalRecord(current) || JSON.stringify(current) !== JSON.stringify(expectedJournal)) {
            throw new Error('Operational migration journal changed; stale batch was rejected.');
          }
          assertOperationalMigrationBinding(current, binding);
          for (const row of prepared) {
            assertWorkspaceLease(lease, workspaceId);
            const request = shadowStore.put(row);
            request.onsuccess = () => {
              try { assertWorkspaceLease(lease, workspaceId); written += 1; } catch (error) { fail(error); }
            };
            request.onerror = () => fail(request.error ?? new Error('Encrypted migration shadow row write failed.'));
          }
          assertWorkspaceLease(lease, workspaceId);
          journalStore.put(nextJournal);
        } catch (error) { fail(error); }
      };
      journalRequest.onerror = () => fail(journalRequest.error ?? new Error('Migration journal compare-and-swap read failed.'));
      tx.oncomplete = () => {
        if (settled) return;
        try { assertWorkspaceLease(lease, workspaceId); settled = true; cleanup(); resolve({ written, journal: nextJournal }); }
        catch (error) { settled = true; cleanup(); reject(error); }
      };
      tx.onerror = () => {
        if (!settled) { settled = true; cleanup(); reject(tx?.error ?? new Error('Encrypted migration transaction failed.')); }
      };
      tx.onabort = () => {
        if (!settled) { settled = true; cleanup(); reject(tx?.error ?? new Error('Encrypted migration transaction aborted.')); }
      };
    } catch (error) { fail(error); }
  });
}

/**
 * Decrypt a bounded cursor scan from the isolated shadow store. No business-field
 * IDB indexes are used; predicates run only after authenticated decryption.
 */
export async function queryEncryptedOperationalStore<T extends Record<string, unknown>>(
  db: IDBDatabase,
  storeName: OperationalEncryptedStore,
  workspaceId: string,
  options: EncryptedOperationalQueryOptions = {}
): Promise<{ items: T[]; scanned: number; hasMore: boolean }> {
  if (!db.objectStoreNames.contains(ENCRYPTED_SHADOW_STORE)) throw new Error('Encrypted operational shadow store does not exist.');
  const maxScan = Math.max(1, Math.min(MAX_QUERY_SCAN, Math.trunc(options.maxScan ?? 2_000)));
  const limit = Math.max(1, Math.min(MAX_QUERY_RESULTS, Math.trunc(options.limit ?? 100)));
  const lease = captureOperationalDataKeyLease();
  assertWorkspaceLease(lease, workspaceId);
  const migrationId = options.migrationId ?? DEFAULT_SHADOW_MIGRATION_ID;
  if (typeof migrationId !== 'string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(migrationId)) {
    throw new Error('Encrypted shadow migration id is invalid.');
  }

  const cursorResult = await new Promise<{ rows: EncryptedOperationalShadowRow[]; hasMore: boolean }>((resolve, reject) => {
    const tx = db.transaction([ENCRYPTED_SHADOW_STORE], 'readonly');
    const index = tx.objectStore(ENCRYPTED_SHADOW_STORE).index('workspaceMigrationStore');
    const request = index.openCursor(workspaceStoreKeyRange(workspaceId, migrationId, storeName));
    const result: EncryptedOperationalShadowRow[] = [];
    let hasMore = false;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (result.length >= maxScan) { hasMore = true; return; }
      result.push(cursor.value as EncryptedOperationalShadowRow);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Encrypted operational shadow cursor failed.'));
    tx.oncomplete = () => resolve({ rows: result, hasMore });
    tx.onerror = () => reject(tx.error ?? new Error('Encrypted operational cursor read failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Encrypted operational cursor read aborted.'));
  });

  const items: T[] = [];
  let scanned = 0;
  for (const row of cursorResult.rows) {
    assertWorkspaceLease(lease, workspaceId);
    const keyField = storeName === 'localProfiles' ? 'workspaceId' : 'id';
    const syntheticRow = { [keyField]: row.recordId, encryptedRecord: row.encryptedRecord };
    if (row.workspaceId !== workspaceId || row.migrationId !== migrationId || row.storeName !== storeName ||
        !isEncryptedOperationalRow(storeName, syntheticRow, workspaceId)) {
      throw new Error('Malformed or cross-workspace encrypted shadow row encountered.');
    }
    const decoded = await decryptOperationalRecord<T>(
      row.encryptedRecord,
      { workspaceId, store: storeName, recordId: row.recordId },
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
