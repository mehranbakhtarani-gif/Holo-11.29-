/**
 * Durable IndexedDB persistence for operational encryption migration journals.
 *
 * Journal rows are metadata-only and are validated at every trust boundary.
 * This module deliberately does not switch readers/writers or alter source data.
 */
import { assertBackupSessionLease, captureBackupSessionLease } from './backupSession';
import {
  assertOperationalMigrationBinding,
  isValidOperationalMigrationJournalRecord,
  transitionOperationalMigrationPhase,
  type OperationalMigrationBinding,
  type OperationalMigrationJournalRecord,
  type OperationalMigrationPhase,
} from './operationalMigrationJournal';

const DB_NAME = 'holoo_apex_operational_db_v1';
const DB_VERSION = 6;
const STORE_NAME = 'operationalMigrationJournal';

function openMigrationDb(): Promise<IDBDatabase> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.reject(new Error('IndexedDB is unavailable for operational migration journal access.'));
  }
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('restoreJournal')) {
        db.createObjectStore('restoreJournal', { keyPath: 'restoreId' });
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'migrationId' });
      }
      const stores = [
        'meta', 'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques',
        'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates',
        'importDossiers', 'salesOrders', 'subcontractJobs', 'rbacOperators', 'auditLogs',
        'syncOutbox', 'syncInbox', 'localProfiles', 'warehouses', 'taxReports',
        'preUpdateBackups', 'secureWorkspace',
      ];
      for (const name of stores) {
        if (!db.objectStoreNames.contains(name)) {
          const keyPath = name === 'meta' ? 'key'
            : name === 'syncOutbox' || name === 'syncInbox' ? 'operationId'
            : name === 'localProfiles' || name === 'secureWorkspace' ? 'workspaceId' : 'id';
          const store = db.createObjectStore(name, { keyPath });
          if (name === 'syncOutbox') {
            store.createIndex('status', 'status', { unique: false });
            store.createIndex('createdAt', 'createdAt', { unique: false });
            store.createIndex('nextRetryAt', 'nextRetryAt', { unique: false });
          } else if (name === 'syncInbox') {
            store.createIndex('receivedAt', 'receivedAt', { unique: false });
          }
        }
      }
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Operational IndexedDB upgrade is blocked by another open connection.'));
    };
    request.onerror = () => { if (!blocked) reject(request.error ?? new Error('Could not open operational IndexedDB.')); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.close();
        reject(new Error('Operational migration journal store is missing.'));
        return;
      }
      resolve(request.result);
    };
  });
}

function assertValidJournal(value: unknown): OperationalMigrationJournalRecord {
  if (!isValidOperationalMigrationJournalRecord(value)) {
    throw new Error('Operational migration journal is corrupt or contains unsupported fields.');
  }
  return value;
}

export async function readOperationalMigrationJournal(
  migrationId: string,
  expectedWorkspaceId?: string
): Promise<OperationalMigrationJournalRecord | null> {
  if (typeof migrationId !== 'string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(migrationId)) {
    throw new Error('Operational migration id is invalid.');
  }
  const db = await openMigrationDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const request = tx.objectStore(STORE_NAME).get(migrationId);
      let result: OperationalMigrationJournalRecord | null = null;
      request.onsuccess = () => {
        if (request.result === undefined) return;
        try {
          const row = assertValidJournal(request.result);
          if (expectedWorkspaceId && row.workspaceId !== expectedWorkspaceId) {
            throw new Error('Operational migration journal belongs to another workspace.');
          }
          result = row;
        } catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error ?? new Error('Operational migration journal read failed.'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('Operational migration journal read transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Operational migration journal read transaction aborted.'));
    });
  } finally { db.close(); }
}

export async function listOperationalMigrationJournals(
  workspaceId: string
): Promise<OperationalMigrationJournalRecord[]> {
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 180) {
    throw new Error('Operational migration workspace identity is invalid.');
  }
  const db = await openMigrationDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        try {
          const rows = ((request.result as unknown[]) ?? []).map(assertValidJournal);
          resolve(rows.filter((row) => row.workspaceId === workspaceId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
        } catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error ?? new Error('Operational migration journal listing failed.'));
      tx.onerror = () => reject(tx.error ?? new Error('Operational migration journal listing transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Operational migration journal listing transaction aborted.'));
    });
  } finally { db.close(); }
}

/** Persist a new run only when no non-terminal run exists for this workspace. */
export async function createOperationalMigrationJournal(
  record: OperationalMigrationJournalRecord
): Promise<void> {
  assertValidJournal(record);
  if (record.phase !== 'preparing') throw new Error('A new migration journal must start in preparing phase.');
  const lease = captureBackupSessionLease();
  assertBackupSessionLease(lease);
  if (lease.generation !== record.backupSessionGeneration) {
    throw new Error('Operational migration journal belongs to a stale backup session.');
  }
  const db = await openMigrationDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          assertBackupSessionLease(lease);
          const rows = ((request.result as unknown[]) ?? []).map(assertValidJournal);
          if (rows.some((row) => row.migrationId === record.migrationId ||
            (row.workspaceId === record.workspaceId &&
             !['rolled_back', 'cutover_committed'].includes(row.phase)))) {
            throw new Error('An existing migration id or active migration prevents journal creation.');
          }
          store.add(record);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('Operational migration journal scan failed.'));
      tx.oncomplete = () => {
        try { assertBackupSessionLease(lease); resolve(); } catch (error) { reject(error); }
      };
      tx.onerror = () => reject(tx.error ?? new Error('Operational migration journal creation failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Operational migration journal creation aborted.'));
    });
  } finally { db.close(); }
}

/** Compare-and-swap a legal phase transition under the original session lease. */
export async function persistOperationalMigrationPhase(
  binding: OperationalMigrationBinding,
  nextPhase: OperationalMigrationPhase
): Promise<OperationalMigrationJournalRecord> {
  const lease = captureBackupSessionLease();
  assertBackupSessionLease(lease);
  if (lease.generation !== binding.backupSessionGeneration) {
    throw new Error('Operational migration session binding is stale.');
  }
  const db = await openMigrationDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let updated: OperationalMigrationJournalRecord | null = null;
      const request = store.get(binding.migrationId);
      request.onsuccess = () => {
        try {
          assertBackupSessionLease(lease);
          const current = assertValidJournal(request.result);
          assertOperationalMigrationBinding(current, binding);
          updated = transitionOperationalMigrationPhase(current, nextPhase);
          store.put(updated);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('Operational migration journal lookup failed.'));
      tx.oncomplete = () => {
        try { assertBackupSessionLease(lease); } catch (error) { reject(error); return; }
        updated ? resolve(updated) : reject(new Error('Operational migration phase was not persisted.'));
      };
      tx.onerror = () => reject(tx.error ?? new Error('Operational migration phase update failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Operational migration phase update aborted.'));
    });
  } finally { db.close(); }
}
