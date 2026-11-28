import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import {
  getBackupSessionGeneration,
  lockBackupSession,
  unlockBackupSession,
} from '../src/lib/backupSession';

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

async function run() {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const fakeWindow = new EventTarget() as EventTarget & {
    indexedDB: IDBFactory;
    IDBKeyRange: typeof IDBKeyRange;
  };
  fakeWindow.indexedDB = indexedDB;
  fakeWindow.IDBKeyRange = IDBKeyRange;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });

  try {
    lockBackupSession();
    unlockBackupSession('MigrationSource#1405');
    const operationalDb = await import('../src/lib/operationalDb');
    const keySession = await import('../src/lib/operationalEncryptionSession');
    const descriptor = await operationalDb.initializeOperationalKeyDescriptor('workspace-source-01');
    await keySession.unlockOperationalDataSessionFromDescriptor(descriptor, 'workspace-source-01');

    const binding = {
      workspaceId: 'workspace-source-01',
      migrationId: 'migration_source_0001',
      sourceRevision: 21,
      backupSessionGeneration: getBackupSessionGeneration(),
    };
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['meta', 'accounts', 'localProfiles'], 'readwrite');
        tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 21 });
        tx.objectStore('accounts').put({ id: 'account-source-01', title: 'Cash' });
        tx.objectStore('accounts').put({ id: 'account-source-02', title: 'Bank' });
        tx.objectStore('localProfiles').put({ workspaceId: 'workspace-source-01', profileId: 'local-one' });
        tx.objectStore('localProfiles').put({ workspaceId: 'workspace-source-02', profileId: 'local-two' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }

    const source = await import('../src/lib/operationalMigrationSource');
    const first = await source.readOperationalMigrationSourceBatch(binding, 'accounts', null, 1);
    assert.equal(first.sourceRevision, 21);
    assert.equal(first.sourceRecordCount, 2);
    assert.deepEqual(first.records, [{ id: 'account-source-01', title: 'Cash' }]);
    assert.equal(first.nextCursor, 'account-source-01');
    assert.equal(first.hasMore, true);

    const second = await source.readOperationalMigrationSourceBatch(
      binding,
      'accounts',
      first.nextCursor,
      1
    );
    assert.deepEqual(second.records, [{ id: 'account-source-02', title: 'Bank' }]);
    assert.equal(second.nextCursor, 'account-source-02');
    assert.equal(second.hasMore, false);

    const localProfile = await source.readOperationalMigrationSourceBatch(binding, 'localProfiles');
    assert.equal(localProfile.sourceRecordCount, 1);
    assert.deepEqual(localProfile.records, [
      { workspaceId: 'workspace-source-01', profileId: 'local-one' },
    ]);
    await assert.rejects(
      () => source.readOperationalMigrationSourceBatch(binding, 'localProfiles', 'workspace-source-01'),
      /does not accept a continuation cursor/
    );

    const writableDb = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = writableDb.transaction(['meta'], 'readwrite');
        tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 22 });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { writableDb.close(); }
    await assert.rejects(
      () => source.readOperationalMigrationSourceBatch(binding, 'accounts'),
      /source revision changed/
    );

    console.log('Operational migration source reader: bounded cursors, workspace-scoped profiles, key lease and source revision checks passed');
    keySession.lockOperationalDataSession();
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
