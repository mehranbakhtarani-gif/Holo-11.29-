import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
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
    const request = indexedDB.open('holoo_apex_operational_db_v1', 7);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRow(db: IDBDatabase, storeName: string, id: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run() {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const fakeWindow = new EventTarget() as EventTarget & { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange };
  fakeWindow.indexedDB = indexedDB;
  fakeWindow.IDBKeyRange = IDBKeyRange;
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
      const plaintextSource = { id: 'account-atomic-1', name: 'Original source account' };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['accounts', 'meta'], 'readwrite');
        tx.objectStore('accounts').put(plaintextSource);
        tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: binding.sourceRevision });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      const first = await writeEncryptedOperationalMigrationBatchAtomically(
        db,
        workspaceId,
        [{ store: 'accounts', records: [
          { id: 'account-atomic-1', name: 'Encrypted account' },
          { id: 'account-atomic-2', name: 'Encrypted account two' },
        ] }],
        copying,
        binding,
        {
          state: 'copying',
          cursor: 'account-atomic-2',
          batchSequence: 1,
          sourceRecordCount: 3,
          copiedRecordCount: 2,
          sourceDigest,
          targetDigest: null,
          storeName: 'accounts',
        }
      );
      assert.equal(first.written, 2);
      assert.equal(first.journal.stores[0].batchSequence, 1);
      assert.equal(first.journal.stores[0].copiedRecordCount, 2);
      await assert.rejects(
        () => writeEncryptedOperationalMigrationBatchAtomically(
          db,
          workspaceId,
          [{ store: 'accounts', records: [{ id: 'account-atomic-invalid', name: 'Must not commit' }] }],
          first.journal,
          binding,
          {
            state: 'copying',
            cursor: 'account-atomic-invalid',
            batchSequence: 2,
            sourceRecordCount: 3,
            copiedRecordCount: 2,
            sourceDigest,
            targetDigest: null,
            storeName: 'accounts',
          }
        ),
        /checkpoint count or cursor/i,
        'checkpoint metadata must account for every row encrypted in its transaction'
      );
      assert.equal(
        await readRow(db, 'encryptedOperationalRecords', [workspaceId, binding.migrationId, 'accounts', 'account-atomic-invalid']),
        undefined,
        'a forged copied-row count must not commit ciphertext'
      );
      const storedFirst = await readRow(
        db,
        'encryptedOperationalRecords',
        [workspaceId, binding.migrationId, 'accounts', 'account-atomic-1']
      ) as Record<string, unknown>;
      assert.equal(typeof storedFirst.encryptedRecord, 'object');
      assert.equal(storedFirst.workspaceId, workspaceId);
      assert.equal(storedFirst.storeName, 'accounts');
      assert.equal(storedFirst.migrationId, binding.migrationId);
      const migrationRead = await (await import('../src/lib/encryptedOperationalIndexedDb')).queryEncryptedOperationalStore(
        db,
        'accounts',
        workspaceId,
        { migrationId: binding.migrationId, limit: 10, maxScan: 10 }
      );
      assert.deepEqual(migrationRead.items, [
        { id: 'account-atomic-1', name: 'Encrypted account' },
        { id: 'account-atomic-2', name: 'Encrypted account two' },
      ]);
      const firstPage = await (await import('../src/lib/encryptedOperationalIndexedDb')).queryEncryptedOperationalStore(
        db, 'accounts', workspaceId,
        { migrationId: binding.migrationId, limit: 1, maxScan: 10 }
      );
      assert.equal(firstPage.items.length, 1);
      assert.equal(firstPage.nextCursor, 'account-atomic-1');
      assert.equal(firstPage.hasMore, true);
      const secondPage = await (await import('../src/lib/encryptedOperationalIndexedDb')).queryEncryptedOperationalStore(
        db, 'accounts', workspaceId,
        { migrationId: binding.migrationId, afterRecordId: firstPage.nextCursor, limit: 1, maxScan: 10 }
      );
      assert.deepEqual(secondPage.items, [{ id: 'account-atomic-2', name: 'Encrypted account two' }]);
      assert.equal(secondPage.hasMore, false);
      const unrelatedMigrationRead = await (await import('../src/lib/encryptedOperationalIndexedDb')).queryEncryptedOperationalStore(
        db,
        'accounts',
        workspaceId,
        { migrationId: 'migration_other_0001', limit: 10, maxScan: 10 }
      );
      assert.deepEqual(unrelatedMigrationRead.items, [], 'shadow rows from another migration run must remain isolated');
      assert.equal(storedFirst.recordId, 'account-atomic-1');
      assert.deepEqual(
        await readRow(db, 'accounts', 'account-atomic-1'),
        plaintextSource,
        'encrypted migration must preserve the original plaintext source row until a separately approved cutover'
      );

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
          [{ store: 'accounts', records: [{ id: 'account-atomic-3', name: 'Must roll back' }] }],
          first.journal,
          binding,
          {
            state: 'copying',
            cursor: 'account-atomic-2',
            batchSequence: 2,
            sourceRecordCount: 3,
            copiedRecordCount: 2,
            sourceDigest,
            targetDigest: null,
            storeName: 'accounts',
          }
        ),
        /abort|Abort|transaction/i
      );
      assert.equal(await readRow(db, 'encryptedOperationalRecords', [workspaceId, binding.migrationId, 'accounts', 'account-atomic-2']), undefined);
      const durable = await persistence.readOperationalMigrationJournal(binding.migrationId);
      assert.deepEqual(durable, first.journal, 'aborted target writes must not advance the durable checkpoint');

      // A restore barrier raised after the transaction opens must abort that transaction.
      const barrierDb = new Proxy(db, {
        get(target, property) {
          if (property === 'transaction') {
            return (...args: Parameters<IDBDatabase['transaction']>) => {
              const tx = target.transaction(...args);
              queueMicrotask(() => operationalDb.setOperationalRestoreBarrier(true));
              return tx;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await assert.rejects(
        () => writeEncryptedOperationalMigrationBatchAtomically(
          barrierDb,
          workspaceId,
          [{ store: 'accounts', records: [{ id: 'account-restore-barrier', name: 'Must not commit' }] }],
          first.journal,
          binding,
          {
            state: 'copying',
            cursor: 'account-restore-barrier',
            batchSequence: 2,
            sourceRecordCount: 3,
            copiedRecordCount: 2,
            sourceDigest,
            targetDigest: null,
            storeName: 'accounts',
          }
        ),
        /restore|blocked|expired/i
      );
      operationalDb.setOperationalRestoreBarrier(false);
      assert.equal(
        await readRow(db, 'encryptedOperationalRecords', [workspaceId, binding.migrationId, 'accounts', 'account-restore-barrier']),
        undefined
      );
      assert.deepEqual(
        await persistence.readOperationalMigrationJournal(binding.migrationId),
        first.journal,
        'restore barrier abort must roll back both shadow writes and journal checkpoint'
      );

      // A changed source revision fences subsequent batches before they can commit.
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['meta'], 'readwrite');
        tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: binding.sourceRevision + 1 });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      await assert.rejects(
        () => writeEncryptedOperationalMigrationBatchAtomically(
          db,
          workspaceId,
          [{ store: 'accounts', records: [{ id: 'account-stale-source', name: 'Must not commit' }] }],
          first.journal,
          binding,
          {
            state: 'copying',
            cursor: 'account-stale-source',
            batchSequence: 2,
            sourceRecordCount: 3,
            copiedRecordCount: 2,
            sourceDigest,
            targetDigest: null,
            storeName: 'accounts',
          }
        ),
        /source revision changed/i
      );
      assert.equal(
        await readRow(db, 'encryptedOperationalRecords', [workspaceId, binding.migrationId, 'accounts', 'account-stale-source']),
        undefined
      );
      assert.deepEqual(
        await persistence.readOperationalMigrationJournal(binding.migrationId),
        first.journal,
        'stale source revision must not advance the migration checkpoint'
      );
      console.log('Encrypted migration batch: atomic checkpoint, source revision fence, restore barrier abort and rollback passed');
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
