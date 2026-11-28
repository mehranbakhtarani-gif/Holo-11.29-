import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import {
  commitChequeStatusOperationalTx,
  commitInvoiceOperationalTx,
} from '../src/lib/operationalDb';

let databaseSequence = 0;

async function createDatabase(stores: Array<{ name: string; keyPath: string }>): Promise<IDBDatabase> {
  const name = `operational-atomicity-test-${++databaseSequence}`;
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    for (const store of stores) request.result.createObjectStore(store.name, { keyPath: store.keyPath });
  };
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRecord<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error ?? new Error(`Read transaction aborted: ${storeName}`));
  });
}

async function countRecords(db: IDBDatabase, storeName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error ?? new Error(`Count transaction aborted: ${storeName}`));
  });
}

async function run() {
  const invoiceDb = await createDatabase([
    { name: 'meta', keyPath: 'key' },
    { name: 'products', keyPath: 'id' },
    { name: 'vouchers', keyPath: 'id' },
    { name: 'cheques', keyPath: 'id' },
    { name: 'invoices', keyPath: 'id' },
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = invoiceDb.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 4 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Meta seed aborted'));
    });

    const product = { id: 'product-1', stock: 8 };
    const voucher = {
      id: 'voucher-1',
      lines: [
        { debit: 1_000, credit: 0 },
        { debit: 0, credit: 1_000 },
      ],
    };
    const cheque = { id: 'cheque-1', amount: 1_000 };
    const invoice = { id: 'invoice-1' };

    assert.equal(await commitInvoiceOperationalTx({
      updatedProducts: [product as never],
      voucher: voucher as never,
      cheque: cheque as never,
      invoice: invoice as never,
    }, { dbOverride: invoiceDb }), true);

    assert.deepEqual(await readRecord(invoiceDb, 'products', 'product-1'), product);
    assert.deepEqual(await readRecord(invoiceDb, 'vouchers', 'voucher-1'), voucher);
    assert.deepEqual(await readRecord(invoiceDb, 'cheques', 'cheque-1'), cheque);
    assert.deepEqual(await readRecord(invoiceDb, 'invoices', 'invoice-1'), invoice);
    assert.equal((await readRecord<{ localRevision: number }>(invoiceDb, 'meta', 'workspace_meta'))?.localRevision, 5);

    await assert.rejects(
      () => commitInvoiceOperationalTx({
        updatedProducts: [{ id: 'product-rollback', stock: 2 } as never],
        voucher: {
          id: 'unbalanced-voucher',
          lines: [
            { debit: 500, credit: 0 },
            { debit: 0, credit: 400 },
          ],
        } as never,
        invoice: { id: 'invoice-rollback' } as never,
      }, { dbOverride: invoiceDb }),
      /سند حسابداری تراز نیست/,
      'invalid ledger data must abort the already queued inventory writes'
    );
    assert.equal(await readRecord(invoiceDb, 'products', 'product-rollback'), undefined);
    assert.equal(await readRecord(invoiceDb, 'vouchers', 'unbalanced-voucher'), undefined);
    assert.equal(await readRecord(invoiceDb, 'invoices', 'invoice-rollback'), undefined);
    assert.equal((await readRecord<{ localRevision: number }>(invoiceDb, 'meta', 'workspace_meta'))?.localRevision, 5);
  } finally {
    invoiceDb.close();
  }

  const chequeDb = await createDatabase([
    { name: 'meta', keyPath: 'key' },
    { name: 'cheques', keyPath: 'id' },
    { name: 'vouchers', keyPath: 'id' },
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = chequeDb.transaction(['meta', 'cheques'], 'readwrite');
      tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 9 });
      tx.objectStore('cheques').put({ id: 'cheque-live', amount: 2_000, status: 'pending' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Cheque seed aborted'));
    });

    const settledCheque = { id: 'cheque-live', amount: 2_000, status: 'cleared' };
    const settlementVoucher = {
      id: 'cheque-settlement-voucher',
      lines: [
        { debit: 2_000, credit: 0 },
        { debit: 0, credit: 2_000 },
      ],
    };
    assert.equal(await commitChequeStatusOperationalTx({
      cheque: settledCheque as never,
      expectedStatus: 'pending' as never,
      voucher: settlementVoucher as never,
    }, { dbOverride: chequeDb }), true);
    assert.deepEqual(await readRecord(chequeDb, 'cheques', 'cheque-live'), settledCheque);
    assert.deepEqual(await readRecord(chequeDb, 'vouchers', 'cheque-settlement-voucher'), settlementVoucher);
    assert.equal((await readRecord<{ localRevision: number }>(chequeDb, 'meta', 'workspace_meta'))?.localRevision, 10);

    await assert.rejects(
      () => commitChequeStatusOperationalTx({
        cheque: { id: 'cheque-live', amount: 2_000, status: 'returned' } as never,
        expectedStatus: 'pending' as never,
        voucher: {
          id: 'must-rollback-voucher',
          lines: [
            { debit: 2_000, credit: 0 },
            { debit: 0, credit: 2_000 },
          ],
        } as never,
      }, { dbOverride: chequeDb }),
      /وضعیت چک هم‌زمان تغییر کرده است/,
      'a stale cheque transition must roll back its voucher and revision writes'
    );
    assert.deepEqual(await readRecord(chequeDb, 'cheques', 'cheque-live'), settledCheque);
    assert.equal(await readRecord(chequeDb, 'vouchers', 'must-rollback-voucher'), undefined);
    assert.equal((await readRecord<{ localRevision: number }>(chequeDb, 'meta', 'workspace_meta'))?.localRevision, 10);
    assert.equal(await countRecords(chequeDb, 'vouchers'), 1);
  } finally {
    chequeDb.close();
  }

  console.log('Operational IndexedDB transaction integration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
