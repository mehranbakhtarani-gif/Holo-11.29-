import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { lockBackupSession, unlockBackupSession, getBackupSessionGeneration } from '../src/lib/backupSession';
import { createOperationalMigrationJournalRecord } from '../src/lib/operationalMigrationJournal';
import { writeEncryptedOperationalMigrationBatchAtomically } from '../src/lib/encryptedOperationalIndexedDb';

const previous = {
  crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  broadcastChannel: Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'),
};

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('holoo_apex_operational_db_v1', 6);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRow(db: IDBDatabase, storeName: string, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run() {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const fakeWindow = new EventTarget() as EventTarget & { indexedDB: IDBFactory };
  fakeWindow.indexedDB = indexedDB;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
  try {
    lockBackupSession();
    unlockBackupSession('AtomicMigration#1405');
    const operationalDb = await import('../src/lib/operationalDb');
    const keySession = await import('../src/lib/operationalEncryptionSession');
    const persistence = await import('../src/lib/operationalMigrationPersistence');
    const workspaceId = 'workspace-migration-atomic';
    const descriptor = await operationalDb.initializeOperationalKeyDescriptor(workspaceId);
    await keySession.unlockOperationalDataSessionFromDescriptor(descriptor, workspaceId);

    const binding = {
      workspaceId,
      migrationId: 'migration_atomic_0001',
      sourceRevision: 21,
      backupSessionGeneration: getBackupSessionGeneration(),
    };
    const now = '2026-11-28T12:00:00.000Z';
    const initial = createOperationalMigrationJournalRecord({
      ...binding,
      sourceSchemaVersion: 5,
      targetFormatVersion: 2,
      storeNames: ['accounts'],
      now,
    });
    await persistence.createOperationalMigrationJournal(initial);
    const copying = await persistence.persistOperationalMigrationPhase(binding, 'copying');
    const sourceDigest = 'a'.repeat(64);
    const db = await openDb();
    try {
      const first = await writeEncryptedOperationalMigrationBatchAtomically(
        db,
        workspaceId,
        [{ store: 'accounts', records: [{ id: 'account-atomic-1', name: 'Encrypted account' }] }],
        copying,
        binding,
        {
          state: 'copying',
          cursor: 'account-atomic-1',
          batchSequence: 1,
          sourceRecordCount: 2,
          copiedRecordCount: 1,
          sourceDigest,
          targetDigest: null,
          storeName: 'accounts',
        }
      );
      assert.equal(first.written, 1);
      assert.equal(first.journal.stores[0].batchSequence, 1);
      assert.equal(first.journal.stores[0].copiedRecordCount, 1);
      const storedFirst = await readRow(db, 'accounts', 'account-atomic-1') as Record<string, unknown>;
      assert.equal(typeof storedFirst.encryptedRecord, 'object');
      assert.equal('name' in storedFirst, false, 'target store must not persist business fields in plaintext');

      // Abort the next readwrite transaction before its journal read can queue writes.
      const abortingDb = new Proxy(db, {
        get(target, property) {
          if (property === 'transaction') {
            return (...args: Parameters<IDBDatabase['transaction']>) => {
              const tx = target.transaction(...args);
              queueMicrotask(() => { try { tx.abort(); } catch { /* already inactive */ } });
              return tx;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await assert.rejects(
        () => writeEncryptedOperationalMigrationBatchAtomically(
          abortingDb,
          workspaceId,
          [{ store: 'accounts', records: [{ id: 'account-atomic-2', name: 'Must roll back' }] }],
          first.journal,
          binding,
          {
            state: 'copying',
            cursor: 'account-atomic-2',
            batchSequence: 2,
            sourceRecordCount: 2,
            copiedRecordCount: 2,
            sourceDigest,
            targetDigest: null,
            storeName: 'accounts',
          }
        ),
        /abort|Abort|transaction/i
      );
      assert.equal(await readRow(db, 'accounts', 'account-atomic-2'), undefined);
      const durable = await persistence.readOperationalMigrationJournal(binding.migrationId);
      assert.deepEqual(durable, first.journal, 'aborted target writes must not advance the durable checkpoint');
      console.log('Encrypted migration batch: target ciphertext and checkpoint commit atomically; aborted transaction rolls back both');
    } finally {
      db.close();
      keySession.lockOperationalDataSession();
    }
  } finally {
    lockBackupSession();
    if (previous.crypto) Object.defineProperty(globalThis, 'crypto', previous.crypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
    if (previous.window) Object.defineProperty(globalThis, 'window', previous.window);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previous.broadcastChannel) Object.defineProperty(globalThis, 'BroadcastChannel', previous.broadcastChannel);
    else Reflect.deleteProperty(globalThis, 'BroadcastChannel');
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
