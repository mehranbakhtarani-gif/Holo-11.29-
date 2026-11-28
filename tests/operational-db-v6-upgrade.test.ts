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

async function seedVersionFive(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      const names = [
        'meta', 'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques',
        'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates',
        'importDossiers', 'salesOrders', 'subcontractJobs', 'rbacOperators', 'auditLogs',
        'syncOutbox', 'syncInbox', 'localProfiles', 'warehouses', 'taxReports',
        'preUpdateBackups', 'secureWorkspace', 'restoreJournal',
      ];
      for (const name of names) {
        if (db.objectStoreNames.contains(name)) continue;
        const keyPath = name === 'meta' ? 'key'
          : name === 'syncOutbox' || name === 'syncInbox' ? 'operationId'
          : name === 'localProfiles' || name === 'secureWorkspace' ? 'workspaceId'
          : name === 'restoreJournal' ? 'restoreId' : 'id';
        const store = db.createObjectStore(name, { keyPath });
        const indexes: Record<string, string[]> = {
          syncOutbox: ['status', 'createdAt', 'nextRetryAt'],
          syncInbox: ['receivedAt'],
          vouchers: ['date', 'status', 'voucherNumber'],
          invoices: ['date', 'partyId', 'status'],
          products: ['warehouse', 'sku'],
          cheques: ['dueDate', 'status'],
          preUpdateBackups: ['createdAt'],
          taxReports: ['period'],
        };
        for (const index of indexes[name] ?? []) store.createIndex(index, index, { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['meta', 'accounts', 'vouchers', 'syncOutbox', 'restoreJournal'], 'readwrite');
      tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 17 });
      tx.objectStore('accounts').put({ id: 'account-v5', name: 'legacy account' });
      tx.objectStore('vouchers').put({ id: 'voucher-v5', date: '1405/01/01', status: 'draft', voucherNumber: 7 });
      tx.objectStore('syncOutbox').put({ operationId: 'outbox-v5', status: 'pending', createdAt: '2026-11-28T00:00:00.000Z' });
      tx.objectStore('restoreJournal').put({ restoreId: 'restore_v5_000001', state: 'committed' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
    request.onerror = () => reject(request.error);
  });
}

async function readRecord(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run() {
  try {
    await seedVersionFive();
    const fakeWindow = { indexedDB } as unknown as Window & { indexedDB: IDBFactory };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
    const operationalDb = await import('../src/lib/operationalDb');

    const heldV5 = await openAtVersion(5);
    await assert.rejects(
      () => operationalDb.loadOperationalKeyDescriptor('migration-schema-test-workspace'),
      /blocked by another open tab\/connection/,
      'the production opener must fail closed when a legacy tab blocks schema upgrade'
    );
    heldV5.close();

    // The production open request resumes after the old connection closes and creates v7.
    const v6 = await openAtVersion(7);
    try {
      assert.equal(v6.version, 7);
      assert.equal(v6.objectStoreNames.contains('operationalMigrationJournal'), true);
      assert.equal(v6.transaction(['operationalMigrationJournal']).objectStore('operationalMigrationJournal').keyPath, 'migrationId');
      const encryptedStore = v6.transaction(['encryptedOperationalRecords']).objectStore('encryptedOperationalRecords');
      assert.deepEqual(encryptedStore.keyPath, ['workspaceId', 'storeName', 'recordId']);
      assert.deepEqual([...encryptedStore.indexNames], ['workspaceStore']);
      const expectedKeyPaths: Record<string, string> = {
        meta: 'key', syncOutbox: 'operationId', syncInbox: 'operationId',
        localProfiles: 'workspaceId', secureWorkspace: 'workspaceId', restoreJournal: 'restoreId',
        accounts: 'id', vouchers: 'id', products: 'id',
      };
      for (const [name, keyPath] of Object.entries(expectedKeyPaths)) {
        assert.equal(v6.transaction([name]).objectStore(name).keyPath, keyPath, `${name} keyPath must remain unchanged`);
      }
      const voucherIndexes = v6.transaction(['vouchers']).objectStore('vouchers').indexNames;
      assert.deepEqual([...voucherIndexes].sort(), ['date', 'status', 'voucherNumber']);
      const outboxIndexes = v6.transaction(['syncOutbox']).objectStore('syncOutbox').indexNames;
      assert.deepEqual([...outboxIndexes].sort(), ['createdAt', 'nextRetryAt', 'status']);
      assert.deepEqual(await readRecord(v6, 'meta', 'workspace_meta'), { key: 'workspace_meta', localRevision: 17 });
      assert.deepEqual(await readRecord(v6, 'accounts', 'account-v5'), { id: 'account-v5', name: 'legacy account' });
      assert.deepEqual(await readRecord(v6, 'vouchers', 'voucher-v5'), {
        id: 'voucher-v5', date: '1405/01/01', status: 'draft', voucherNumber: 7,
      });
      assert.deepEqual(await readRecord(v6, 'syncOutbox', 'outbox-v5'), {
        operationId: 'outbox-v5', status: 'pending', createdAt: '2026-11-28T00:00:00.000Z',
      });
      assert.deepEqual(await readRecord(v6, 'restoreJournal', 'restore_v5_000001'), {
        restoreId: 'restore_v5_000001', state: 'committed',
      });
      assert.equal(await readRecord(v6, 'operationalMigrationJournal', 'missing'), undefined);
    } finally {
      v6.close();
    }

    // The fixture intentionally seeds a minimal committed restore-journal row;
    // it is not a full production restore record and must keep normal workspace
    // access fail-closed. The blocked production open and deferred schema upgrade
    // are already asserted above, so do not call a normal workspace API here.
    console.log('Operational IndexedDB v5→v7 production upgrade: data, keyPaths, indexes, and blocked-tab behavior passed');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousBroadcastChannel) Object.defineProperty(globalThis, 'BroadcastChannel', previousBroadcastChannel);
    else Reflect.deleteProperty(globalThis, 'BroadcastChannel');
  }
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
