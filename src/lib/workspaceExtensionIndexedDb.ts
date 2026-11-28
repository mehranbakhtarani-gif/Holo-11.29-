import {
  advanceWorkspaceExtensionMigration,
  decideWorkspaceExtensionCommit,
  validateWorkspaceExtensionRecord,
  type WorkspaceExtensionCommitResult,
  type WorkspaceExtensionMigrationJournal,
  type WorkspaceExtensionMigrationState,
  type WorkspaceExtensionRecord,
} from './workspaceExtensionRepository';

const ROWS = 'rows';
const JOURNAL = 'migrationJournal';

export interface WorkspaceExtensionIndexedDbOptions {
  factory: IDBFactory;
  databaseName?: string;
  /** Test seam for deterministic transaction-abort coverage. */
  onTransactionCreated?: (transaction: IDBTransaction) => void;
  /** Test seam invoked after row and journal writes are queued but before commit. */
  onWritesQueued?: (transaction: IDBTransaction) => void;
  isRestoreBarrierActive?: () => boolean;
}

export interface WorkspaceExtensionIndexedDbRepository<T> {
  read(workspaceId: string): Promise<WorkspaceExtensionRecord<T> | null>;
  readMigrationJournal(workspaceId: string, migrationId: string): Promise<WorkspaceExtensionMigrationJournal | null>;
  advanceMigration(params: {
    workspaceId: string;
    migrationId: string;
    sourceFingerprint: string;
    targetGeneration: number;
    nextState: WorkspaceExtensionMigrationState;
    now: string;
  }): Promise<WorkspaceExtensionMigrationJournal>;
  commit(params: {
    workspaceId: string;
    expectedGeneration: number;
    payload: T;
    now: string;
    migration?: {
      journal: WorkspaceExtensionMigrationJournal;
      nextState: WorkspaceExtensionMigrationState;
    };
  }): Promise<WorkspaceExtensionCommitResult<T>>;
  close(): void;
}

/**
 * Isolated IndexedDB adapter for contract testing and future integration.
 * It uses a dedicated database and is NOT connected to the operational DB,
 * production readers, or production writers.
 */
export function createWorkspaceExtensionIndexedDbRepository<T = unknown>(
  options: WorkspaceExtensionIndexedDbOptions
): Promise<WorkspaceExtensionIndexedDbRepository<T>> {
  const databaseName = options.databaseName ?? 'holoo_workspace_extensions_adapter_test_v1';
  return new Promise((resolve, reject) => {
    const request = options.factory.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ROWS)) db.createObjectStore(ROWS, { keyPath: 'workspaceId' });
      if (!db.objectStoreNames.contains(JOURNAL)) {
        db.createObjectStore(JOURNAL, { keyPath: ['workspaceId', 'migrationId'] });
      }
    };
    request.onerror = () => { if (!blocked) reject(request.error ?? new Error('Unable to open extension adapter database.')); };
    request.onblocked = () => { blocked = true; reject(new Error('Extension adapter database upgrade is blocked.')); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      const ensureWritable = () => {
        if (options.isRestoreBarrierActive?.()) {
          throw new Error('Workspace extension writes are blocked by the active restore barrier.');
        }
      };
      const read = (workspaceId: string) => new Promise<WorkspaceExtensionRecord<T> | null>((res, rej) => {
        if (!workspaceId.trim()) return rej(new Error('workspaceId is required.'));
        const tx = db.transaction(ROWS, 'readonly');
        const get = tx.objectStore(ROWS).get(workspaceId);
        let value: WorkspaceExtensionRecord<T> | null = null;
        let failure: Error | undefined;
        get.onsuccess = () => {
          value = get.result ?? null;
          if (value !== null && !validateWorkspaceExtensionRecord<T>(value, workspaceId)) {
            failure = new Error('Stored workspace extension record is invalid.');
            tx.abort();
          }
        };
        get.onerror = () => { failure = get.error ?? new Error('Unable to read workspace extension record.'); tx.abort(); };
        tx.oncomplete = () => failure ? rej(failure) : res(value);
        tx.onabort = () => rej(failure ?? tx.error ?? new Error('Workspace extension read aborted.'));
      });
      const readMigrationJournal = (workspaceId: string, migrationId: string) =>
        new Promise<WorkspaceExtensionMigrationJournal | null>((res, rej) => {
          const tx = db.transaction(JOURNAL, 'readonly');
          const get = tx.objectStore(JOURNAL).get([workspaceId, migrationId]);
          let value: WorkspaceExtensionMigrationJournal | null = null;
          let failure: Error | undefined;
          get.onsuccess = () => { value = (get.result as WorkspaceExtensionMigrationJournal | undefined) ?? null; };
          get.onerror = () => { failure = get.error ?? new Error('Unable to read migration journal.'); tx.abort(); };
          tx.oncomplete = () => failure ? rej(failure) : res(value);
          tx.onabort = () => rej(failure ?? tx.error ?? new Error('Migration journal read aborted.'));
        });
      const advanceMigration = (params: {
        workspaceId: string;
        migrationId: string;
        sourceFingerprint: string;
        targetGeneration: number;
        nextState: WorkspaceExtensionMigrationState;
        now: string;
      }) => new Promise<WorkspaceExtensionMigrationJournal>((res, rej) => {
        try {
          ensureWritable();
          const tx = db.transaction([ROWS, JOURNAL], 'readwrite');
          const rows = tx.objectStore(ROWS);
          const journals = tx.objectStore(JOURNAL);
          let outcome: WorkspaceExtensionMigrationJournal | undefined;
          let failure: Error | undefined;
          const rowRequest = rows.get(params.workspaceId);
          rowRequest.onerror = () => { failure = rowRequest.error ?? new Error('Unable to verify migration target row.'); tx.abort(); };
          rowRequest.onsuccess = () => {
            try {
              ensureWritable();
              const row = rowRequest.result as WorkspaceExtensionRecord<T> | undefined;
              if (!row || !validateWorkspaceExtensionRecord<T>(row, params.workspaceId) ||
                  row.generation !== params.targetGeneration) {
                throw new Error('Migration target generation does not match the verified extension record.');
              }
              const journalRequest = journals.get([params.workspaceId, params.migrationId]);
              journalRequest.onerror = () => { failure = journalRequest.error ?? new Error('Unable to read migration journal.'); tx.abort(); };
              journalRequest.onsuccess = () => {
                try {
                  const current = journalRequest.result as WorkspaceExtensionMigrationJournal | undefined;
                  if (!current) throw new Error('Migration journal does not exist.');
                  if (current.sourceFingerprint !== params.sourceFingerprint ||
                      current.targetGeneration !== params.targetGeneration) {
                    throw new Error('Migration journal identity does not match the requested transition.');
                  }
                  const next = advanceWorkspaceExtensionMigration(current, params.nextState, params.now);
                  journals.put(next);
                  outcome = next;
                } catch (error) {
                  failure = error instanceof Error ? error : new Error(String(error));
                  tx.abort();
                }
              };
            } catch (error) {
              failure = error instanceof Error ? error : new Error(String(error));
              tx.abort();
            }
          };
          tx.oncomplete = () => outcome ? res(outcome) : rej(failure ?? new Error('Migration transition completed without a result.'));
          tx.onabort = () => rej(failure ?? tx.error ?? new Error('Migration transition aborted.'));
        } catch (error) {
          rej(error instanceof Error ? error : new Error(String(error)));
        }
      });
      const commit = (params: {
        workspaceId: string;
        expectedGeneration: number;
        payload: T;
        now: string;
        migration?: { journal: WorkspaceExtensionMigrationJournal; nextState: WorkspaceExtensionMigrationState };
      }) => new Promise<WorkspaceExtensionCommitResult<T>>((res, rej) => {
        try {
          ensureWritable();
          if (!params.workspaceId.trim() || params.workspaceId.length > 180) {
            throw new Error('A valid workspaceId is required.');
          }
          if (params.migration && params.migration.journal.workspaceId !== params.workspaceId) {
            throw new Error('Migration journal workspace does not match the commit workspace.');
          }
          const tx = db.transaction([ROWS, JOURNAL], 'readwrite');
          options.onTransactionCreated?.(tx);
          const rows = tx.objectStore(ROWS);
          const journals = tx.objectStore(JOURNAL);
          let outcome: WorkspaceExtensionCommitResult<T> | undefined;
          let failure: Error | undefined;
          const currentRequest = rows.get(params.workspaceId);
          currentRequest.onerror = () => { failure = currentRequest.error ?? new Error('Unable to read current generation.'); tx.abort(); };
          currentRequest.onsuccess = () => {
            try {
              ensureWritable();
              const current = currentRequest.result ?? null;
              if (current !== null && !validateWorkspaceExtensionRecord<T>(current, params.workspaceId)) {
                throw new Error('Stored workspace extension record is invalid.');
              }
              const decision = decideWorkspaceExtensionCommit({
                workspaceId: params.workspaceId,
                current,
                expectedGeneration: params.expectedGeneration,
                payload: params.payload,
                now: params.now,
              });
              if (decision.status === 'conflict') {
                outcome = decision;
                return;
              }
              if (params.migration) {
                const { journal, nextState } = params.migration;
                if (nextState !== 'staging') {
                  throw new Error('A migration journal must be created in staging; use advanceMigration for later states.');
                }
                if (journal.targetGeneration !== decision.record.generation) {
                  throw new Error('Migration target generation must equal the committed record generation.');
                }
                const journalKey = [journal.workspaceId, journal.migrationId];
                const journalRequest = journals.get(journalKey);
                journalRequest.onerror = () => { failure = journalRequest.error ?? new Error('Unable to read migration journal.'); tx.abort(); };
                journalRequest.onsuccess = () => {
                  try {
                    const existing = journalRequest.result as WorkspaceExtensionMigrationJournal | undefined;
                    if (existing) throw new Error('Migration journal already exists; use advanceMigration for later states.');
                    const next = advanceWorkspaceExtensionMigration(journal, nextState, params.now);
                    journals.put(next);
                    rows.put(decision.record);
                    options.onWritesQueued?.(tx);
                    outcome = decision;
                  } catch (error) {
                    failure = error instanceof Error ? error : new Error(String(error));
                    tx.abort();
                  }
                };
              } else {
                rows.put(decision.record);
                options.onWritesQueued?.(tx);
                outcome = decision;
              }
            } catch (error) {
              failure = error instanceof Error ? error : new Error(String(error));
              tx.abort();
            }
          };
          tx.oncomplete = () => {
            if (failure) rej(failure);
            else if (outcome) res(outcome);
            else rej(new Error('Workspace extension transaction completed without a result.'));
          };
          tx.onabort = () => rej(failure ?? tx.error ?? new Error('Workspace extension transaction aborted.'));
          tx.onerror = () => { /* onabort owns rejection */ };
        } catch (error) {
          rej(error instanceof Error ? error : new Error(String(error)));
        }
      });
      resolve({ read, readMigrationJournal, advanceMigration, commit, close: () => db.close() });
    };
  });
}
