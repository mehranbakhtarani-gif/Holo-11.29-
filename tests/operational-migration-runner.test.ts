import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { lockBackupSession, unlockBackupSession, getBackupSessionGeneration } from '../src/lib/backupSession';

const previous = {
  crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  broadcastChannel: Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'),
};

async function run() {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const fakeWindow = new EventTarget() as EventTarget & { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange };
  fakeWindow.indexedDB = indexedDB;
  fakeWindow.IDBKeyRange = IDBKeyRange;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
  try {
    lockBackupSession();
    unlockBackupSession('MigrationRunner#1405');
    const operationalDb = await import('../src/lib/operationalDb');
    const keySession = await import('../src/lib/operationalEncryptionSession');
    const persistence = await import('../src/lib/operationalMigrationPersistence');
    const journalModule = await import('../src/lib/operationalMigrationJournal');
    const runner = await import('../src/lib/operationalMigrationRunner');
    const encryptedDb = await import('../src/lib/encryptedOperationalIndexedDb');

    const workspaceId = 'workspace-runner-01';
    const migrationId = 'migration_runner_001';
    const descriptor = await operationalDb.initializeOperationalKeyDescriptor(workspaceId);
    await keySession.unlockOperationalDataSessionFromDescriptor(descriptor, workspaceId);
    const binding = {
      workspaceId,
      migrationId,
      sourceRevision: 7,
      backupSessionGeneration: getBackupSessionGeneration(),
    };
    const db = await operationalDb.openOperationalMigrationDbConnection();
    const source = { id: 'runner-account-01', workspaceId, name: 'Migration source', balance: 4250 };
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['accounts', 'meta'], 'readwrite');
        tx.objectStore('accounts').put(source);
        tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: binding.sourceRevision });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });

      const incomplete = journalModule.createOperationalMigrationJournalRecord({
        ...binding,
        sourceSchemaVersion: 7,
        targetFormatVersion: 1,
        storeNames: ['accounts'],
      });
      await assert.rejects(
        () => runner.runOperationalShadowMigration(binding, incomplete),
        /every required business store exactly once/i,
        'a partial store list must never be certified as a complete migration'
      );

      const initial = journalModule.createOperationalMigrationJournalRecord({
        ...binding,
        sourceSchemaVersion: 7,
        targetFormatVersion: 1,
        storeNames: runner.OPERATIONAL_MIGRATION_STORES,
      });
      await persistence.createOperationalMigrationJournal(initial);
      const completed = await runner.runOperationalShadowMigration(binding, initial);
      assert.equal(completed.phase, 'ready_to_cutover');
      assert.equal(completed.stores[0].state, 'verified');
      assert.equal(completed.stores[0].sourceRecordCount, 1);
      assert.equal(completed.stores[0].copiedRecordCount, 1);
      assert.equal(completed.stores[0].sourceDigest, completed.stores[0].targetDigest);

      const sourceStillPresent = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(['accounts'], 'readonly');
        const request = tx.objectStore('accounts').get(source.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      assert.deepEqual(sourceStillPresent, source, 'shadow migration must preserve the authoritative plaintext source');

      const target = await encryptedDb.queryEncryptedOperationalStore(
        db, 'accounts', workspaceId,
        { migrationId, limit: 10, maxScan: 10 }
      );
      assert.deepEqual(target.items, [source]);
      assert.equal(target.hasMore, false);
      const resumed = await runner.runOperationalShadowMigration(binding, completed);
      assert.deepEqual(resumed, completed, 'a completed shadow migration is safe to re-open without rewriting data');
      console.log('Operational migration runner: copy, digest verification, ready gate, source preservation and idempotent resume passed');
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
