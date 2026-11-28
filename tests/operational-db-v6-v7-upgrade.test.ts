import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';

const DB_NAME = 'holoo_apex_operational_db_v1';
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');

async function openAtVersion(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function seedVersionSix(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 6);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('accounts', { keyPath: 'id' });
      db.createObjectStore('vouchers', { keyPath: 'id' });
      db.createObjectStore('restoreJournal', { keyPath: 'restoreId' });
      db.createObjectStore('operationalMigrationJournal', { keyPath: 'migrationId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['meta', 'accounts', 'vouchers'], 'readwrite');
      tx.objectStore('meta').put({ key: 'schema-v6', revision: 31 });
      tx.objectStore('accounts').put({ id: 'account-v6', title: 'Legacy plaintext source' });
      tx.objectStore('vouchers').put({ id: 'voucher-v6', total: 7800, status: 'draft' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
    request.onerror = () => reject(request.error);
  });
}

async function readRecord(db: IDBDatabase, store: string, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store], 'readonly');
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run() {
  try {
    await seedVersionSix();
    const fakeWindow = { indexedDB } as unknown as Window & { indexedDB: IDBFactory };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
    const operationalDb = await import('../src/lib/operationalDb');

    await operationalDb.loadOperationalKeyDescriptor('v6-v7-upgrade-workspace');
    const db = await openAtVersion(7);
    try {
      assert.equal(db.version, 7);
      assert.equal(db.objectStoreNames.contains('encryptedOperationalRecords'), true);
      const shadow = db.transaction(['encryptedOperationalRecords']).objectStore('encryptedOperationalRecords');
      assert.deepEqual(shadow.keyPath, ['workspaceId', 'migrationId', 'storeName', 'recordId']);
      assert.equal(shadow.indexNames.contains('workspaceMigrationStore'), true);
      assert.deepEqual(await readRecord(db, 'meta', 'schema-v6'), { key: 'schema-v6', revision: 31 });
      assert.deepEqual(await readRecord(db, 'accounts', 'account-v6'), {
        id: 'account-v6', title: 'Legacy plaintext source',
      });
      assert.deepEqual(await readRecord(db, 'vouchers', 'voucher-v6'), {
        id: 'voucher-v6', total: 7800, status: 'draft',
      });
      console.log('Operational IndexedDB v6→v7: isolated encrypted shadow schema added without changing source records');
    } finally { db.close(); }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousBroadcastChannel) Object.defineProperty(globalThis, 'BroadcastChannel', previousBroadcastChannel);
    else Reflect.deleteProperty(globalThis, 'BroadcastChannel');
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
