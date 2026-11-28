import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';

const DB_NAME = 'holoo_apex_operational_db_v1';
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

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
    const heldV5 = await openAtVersion(5);
    const blockedUpgrade = await new Promise<{ blocked: boolean; completed: boolean }>((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(DB_NAME, 6);
      request.onblocked = () => { blocked = true; };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const upgraded = request.result;
        const completed = upgraded.version === 6 &&
          upgraded.objectStoreNames.contains('operationalMigrationJournal');
        upgraded.close();
        resolve({ blocked, completed });
      };
      queueMicrotask(() => heldV5.close());
    });
    assert.deepEqual(blockedUpgrade, { blocked: true, completed: true },
      'a v5 connection must block the upgrade until it closes, then v6 must complete');

    const v6 = await openAtVersion(6);
    try {
      assert.equal(v6.version, 6);
      assert.equal(v6.objectStoreNames.contains('operationalMigrationJournal'), true);
      assert.equal(v6.transaction(['operationalMigrationJournal']).objectStore('operationalMigrationJournal').keyPath, 'migrationId');
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

    // Exercise the production open path against the already-upgraded database.
    const fakeWindow = { indexedDB } as unknown as Window & { indexedDB: IDBFactory };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    const operationalDb = await import('../src/lib/operationalDb');
    await operationalDb.loadOperationalKeyDescriptor('migration-schema-test-workspace');
    console.log('Operational IndexedDB v5→v6 upgrade: data, keyPaths, indexes, and blocked-tab behavior passed');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
