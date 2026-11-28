/**
 * Bounded, read-only source access for the operational encryption migration.
 * The source revision and batch rows are read in one readonly IndexedDB
 * transaction so callers never migrate a mixed revision.
 */
import { openOperationalMigrationDbConnection } from './operationalDb';
import { getOperationalRecordPrimaryKey } from './encryptedOperationalRecordAdapter';
import { assertOperationalDataKeyLease, captureOperationalDataKeyLease } from './operationalEncryptionSession';
import type { OperationalEncryptedStore } from './operationalRecordEncryption';
import type { OperationalMigrationBinding } from './operationalMigrationJournal';

export interface OperationalMigrationSourceBatch {
  workspaceId: string;
  migrationId: string;
  storeName: OperationalEncryptedStore;
  sourceRevision: number;
  sourceRecordCount: number;
  records: Record<string, unknown>[];
  nextCursor: string | null;
  hasMore: boolean;
}

function sourceKeyRange(afterCursor: string | null): IDBKeyRange | undefined {
  if (afterCursor === null) return undefined;
  const keyRange = typeof window !== 'undefined' ? window.IDBKeyRange : globalThis.IDBKeyRange;
  if (!keyRange) throw new Error('IndexedDB key-range support is unavailable.');
  return keyRange.lowerBound(afterCursor, true);
}

/**
 * Read one bounded page from the unchanged plaintext source. This function
 * never writes or deletes source rows; every call verifies the original
 * workspace revision before returning any data to the caller.
 */
export async function readOperationalMigrationSourceBatch(
  binding: OperationalMigrationBinding,
  storeName: OperationalEncryptedStore,
  afterCursor: string | null = null,
  requestedLimit = 500
): Promise<OperationalMigrationSourceBatch> {
  if (!binding || typeof binding.workspaceId !== 'string' || !binding.workspaceId.trim() ||
      typeof binding.migrationId !== 'string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(binding.migrationId) ||
      !Number.isSafeInteger(binding.sourceRevision) || binding.sourceRevision < 1 ||
      !Number.isSafeInteger(binding.backupSessionGeneration) || binding.backupSessionGeneration < 0) {
    throw new Error('Operational migration source binding is invalid.');
  }
  if (!(afterCursor === null || (typeof afterCursor === 'string' && afterCursor.length > 0 && afterCursor.length <= 512))) {
    throw new Error('Operational migration source cursor is invalid.');
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1_000) {
    throw new Error('Operational migration source batch limit must be between 1 and 1000.');
  }

  const lease = captureOperationalDataKeyLease();
  assertOperationalDataKeyLease(lease);
  if (lease.workspaceId !== binding.workspaceId || lease.backupSessionGeneration !== binding.backupSessionGeneration) {
    throw new Error('Operational migration source read belongs to another workspace or backup session.');
  }
  const assertSourceLease = () => {
    assertOperationalDataKeyLease(lease);
    if (lease.workspaceId !== binding.workspaceId || lease.backupSessionGeneration !== binding.backupSessionGeneration) {
      throw new Error('Operational migration source lease expired or changed workspace.');
    }
  };
  const db = await openOperationalMigrationDbConnection();
  try {
    if (!db.objectStoreNames.contains(storeName) || !db.objectStoreNames.contains('meta')) {
      throw new Error('Operational migration source or metadata store is missing.');
    }
    return await new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try { assertSourceLease(); tx = db.transaction([storeName, 'meta'], 'readonly'); }
      catch (error) { reject(error); return; }
      const sourceStore = tx.objectStore(storeName);
      const metaRequest = tx.objectStore('meta').get('workspace_meta');
      let sourceRevision: number | null = null;
      let sourceRecordCount: number | null = null;
      let records: Record<string, unknown>[] = [];
      let nextCursor: string | null = null;
      let hasMore = false;
      let readFailed = false;

      const fail = (error: unknown) => {
        if (readFailed) return;
        readFailed = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      metaRequest.onsuccess = () => {
        try { assertSourceLease(); } catch (error) { fail(error); try { tx.abort(); } catch { /* inactive */ } return; }
        const meta = metaRequest.result as { localRevision?: unknown } | undefined;
        if (!meta || !Number.isSafeInteger(meta.localRevision) || meta.localRevision !== binding.sourceRevision) {
          fail(new Error('Operational source revision changed or is unavailable; migration batch was rejected.'));
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          return;
        }
        sourceRevision = meta.localRevision as number;
      };
      metaRequest.onerror = () => fail(metaRequest.error ?? new Error('Operational source revision read failed.'));

      if (storeName === 'localProfiles') {
        const profileRequest = sourceStore.get(binding.workspaceId);
        profileRequest.onsuccess = () => {
          try { assertSourceLease(); } catch (error) { fail(error); try { tx.abort(); } catch { /* inactive */ } return; }
          if (profileRequest.result === undefined) {
            sourceRecordCount = 0;
            return;
          }
          const row = profileRequest.result as Record<string, unknown>;
          try {
            const recordId = getOperationalRecordPrimaryKey(storeName, row);
            if (recordId !== binding.workspaceId) throw new Error('Local profile source row belongs to another workspace.');
            records = [row];
            sourceRecordCount = 1;
            nextCursor = recordId;
          } catch (error) { fail(error); }
        };
        profileRequest.onerror = () => fail(profileRequest.error ?? new Error('Local profile migration source read failed.'));
      } else {
        const countRequest = sourceStore.count();
        countRequest.onsuccess = () => {
          try { assertSourceLease(); sourceRecordCount = countRequest.result; }
          catch (error) { fail(error); try { tx.abort(); } catch { /* inactive */ } }
        };
        countRequest.onerror = () => fail(countRequest.error ?? new Error('Operational source record count failed.'));

        const range = sourceKeyRange(afterCursor);
        const cursorRequest = range ? sourceStore.openCursor(range) : sourceStore.openCursor();
        cursorRequest.onsuccess = () => {
          try { assertSourceLease(); } catch (error) { fail(error); try { tx.abort(); } catch { /* inactive */ } return; }
          const cursor = cursorRequest.result;
          if (!cursor) return;
          if (records.length >= requestedLimit) {
            hasMore = true;
            return;
          }
          try {
            const row = cursor.value as Record<string, unknown>;
            if (!row || typeof row !== 'object' || Array.isArray(row)) {
              throw new Error('Operational migration source contains a malformed record.');
            }
            if (typeof row.workspaceId === 'string' && row.workspaceId !== binding.workspaceId) {
              throw new Error('Operational migration source contains a cross-workspace record.');
            }
            const recordId = getOperationalRecordPrimaryKey(storeName, row);
            records.push(row);
            nextCursor = recordId;
            cursor.continue();
          } catch (error) {
            fail(error);
            try { tx.abort(); } catch { /* transaction may already be inactive */ }
          }
        };
        cursorRequest.onerror = () => fail(cursorRequest.error ?? new Error('Operational migration source cursor failed.'));
      }

      tx.oncomplete = () => {
        if (readFailed) return;
        try { assertSourceLease(); } catch (error) { reject(error); return; }
        if (sourceRevision !== binding.sourceRevision || sourceRecordCount === null || !Number.isSafeInteger(sourceRecordCount)) {
          reject(new Error('Operational migration source snapshot was incomplete.'));
          return;
        }
        resolve({
          workspaceId: binding.workspaceId,
          migrationId: binding.migrationId,
          storeName,
          sourceRevision,
          sourceRecordCount,
          records,
          nextCursor,
          hasMore,
        });
      };
      tx.onerror = () => { if (!readFailed) reject(tx.error ?? new Error('Operational migration source transaction failed.')); };
      tx.onabort = () => { if (!readFailed) reject(tx.error ?? new Error('Operational migration source transaction aborted.')); };
    });
  } finally { db.close(); }
}
