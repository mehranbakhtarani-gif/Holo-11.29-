import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import {
  commitChequeStatusOperationalTx,
  commitDepreciationOperationalTx,
  commitInvoiceOperationalTx,
  commitSalesOrderDispatchOperationalTx,
  commitStockAdjustmentOperationalTx,
} from '../src/lib/operationalDb';

let databaseSequence = 0;

async function createDatabase(stores: Array<{ name: string; keyPath: string; uniqueIndexes?: Array<{ name: string; keyPath: string }> }>): Promise<IDBDatabase> {
  const name = `operational-atomicity-test-${++databaseSequence}`;
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    for (const store of stores) {
      const objectStore = request.result.createObjectStore(store.name, { keyPath: store.keyPath });
      for (const index of store.uniqueIndexes ?? []) objectStore.createIndex(index.name, index.keyPath, { unique: true });
    }
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

  // Inject a real IndexedDB ConstraintError after the product write has been queued.
  // The unique index forces the later voucher put to fail asynchronously, exercising tx abort.
  const failureDb = await createDatabase([
    { name: 'meta', keyPath: 'key' },
    { name: 'products', keyPath: 'id' },
    { name: 'vouchers', keyPath: 'id', uniqueIndexes: [{ name: 'failureKey', keyPath: 'failureKey' }] },
    { name: 'cheques', keyPath: 'id' },
    { name: 'invoices', keyPath: 'id' },
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = failureDb.transaction(['meta', 'vouchers'], 'readwrite');
      tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 50 });
      tx.objectStore('vouchers').put({ id: 'existing-voucher', failureKey: 'duplicate-index-value' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Failure-injection seed aborted'));
    });

    await assert.rejects(
      () => commitInvoiceOperationalTx({
        updatedProducts: [{ id: 'product-must-rollback', stock: 7 } as never],
        voucher: {
          id: 'voucher-constraint-failure',
          failureKey: 'duplicate-index-value',
          lines: [{ debit: 700, credit: 0 }, { debit: 0, credit: 700 }],
        } as never,
        invoice: { id: 'invoice-must-rollback' } as never,
      }, { dbOverride: failureDb }),
      (error: unknown) => error instanceof DOMException && error.name === 'ConstraintError',
      'a unique-index ConstraintError must reject the atomic invoice transaction'
    );
    assert.equal(await readRecord(failureDb, 'products', 'product-must-rollback'), undefined);
    assert.equal(await readRecord(failureDb, 'vouchers', 'voucher-constraint-failure'), undefined);
    assert.equal(await readRecord(failureDb, 'invoices', 'invoice-must-rollback'), undefined);
    assert.deepEqual(await readRecord(failureDb, 'vouchers', 'existing-voucher'), {
      id: 'existing-voucher', failureKey: 'duplicate-index-value',
    });
    assert.equal((await readRecord<{ localRevision: number }>(failureDb, 'meta', 'workspace_meta'))?.localRevision, 50);
  } finally {
    failureDb.close();
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


  const dispatchDb = await createDatabase([
    { name: 'meta', keyPath: 'key' },
    { name: 'salesOrders', keyPath: 'id' },
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = dispatchDb.transaction(['meta', 'salesOrders'], 'readwrite');
      tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 20 });
      tx.objectStore('salesOrders').put({
        id: 'order-1', ownerId: 'owner-1', orderNumber: 'SO-1', date: '2026-01-01',
        partyId: 'party-1', partyName: 'Buyer', warehouse: 'Main', status: 'ordered',
        items: [], _version: 3,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Sales order seed aborted'));
    });
    const dispatched = await commitSalesOrderDispatchOperationalTx({
      orderId: 'order-1', ownerId: 'owner-1', dispatchNumber: 'DN-1',
      dispatchDate: '2026-01-02', driverName: 'Driver', plateNumber: '11A111',
      items: [], updatedByDevice: 'indexeddb-test',
    }, { dbOverride: dispatchDb });
    assert.equal(dispatched.status, 'dispatched');
    assert.equal(dispatched._version, 4);
    assert.equal((await readRecord<{ localRevision: number }>(dispatchDb, 'meta', 'workspace_meta'))?.localRevision, 21);

    await assert.rejects(
      () => commitSalesOrderDispatchOperationalTx({
        orderId: 'order-1', ownerId: 'owner-1', dispatchNumber: 'DN-2',
        dispatchDate: '2026-01-03', driverName: 'Driver', plateNumber: '11A111',
        items: [], updatedByDevice: 'indexeddb-test',
      }, { dbOverride: dispatchDb }),
      /قبلاً حواله شده|وضعیت قابل ارسال نیست/,
      'a repeated dispatch must reject a non-ordered sales order'
    );
    assert.equal((await readRecord<{ status: string; _version: number }>(dispatchDb, 'salesOrders', 'order-1'))?.status, 'dispatched');
    assert.equal((await readRecord<{ localRevision: number }>(dispatchDb, 'meta', 'workspace_meta'))?.localRevision, 21);
  } finally {
    dispatchDb.close();
  }

  const depreciationDb = await createDatabase([
    { name: 'meta', keyPath: 'key' },
    { name: 'assets', keyPath: 'id' },
    { name: 'vouchers', keyPath: 'id' },
  ]);
  try {
    const asset = {
      id: 'asset-1', ownerId: 'owner-1', assetCode: 'FA-1', title: 'Equipment',
      purchaseDate: '2024-01-01', purchaseCost: 10_000, salvageValue: 1_000,
      usefulLifeYears: 5, accumulatedDepreciation: 1_000,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = depreciationDb.transaction(['meta', 'assets'], 'readwrite');
      tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 30 });
      tx.objectStore('assets').put(asset);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Asset seed aborted'));
    });
    const depreciationVoucher = {
      id: 'depreciation-voucher-1', ownerId: 'owner-1', voucherNumber: 101,
      status: 'permanent', voucherType: 'depreciation', referenceId: 'period-2026-01',
      totalDebit: 500, totalCredit: 500,
      lines: [{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }],
    };
    const assetUpdate = {
      id: 'asset-1', expectedAccumulatedDepreciation: 1_000,
      expectedPurchaseCost: 10_000, expectedSalvageValue: 1_000,
      expectedUsefulLifeYears: 5, expectedPurchaseDate: '2024-01-01',
      depreciationAmount: 500, accumulatedDepreciation: 1_500,
    };
    assert.equal(await commitDepreciationOperationalTx({
      assetUpdates: [assetUpdate], voucher: depreciationVoucher as never,
    }, { dbOverride: depreciationDb }), true);
    assert.equal((await readRecord<{ accumulatedDepreciation: number }>(depreciationDb, 'assets', 'asset-1'))?.accumulatedDepreciation, 1_500);
    assert.deepEqual(await readRecord(depreciationDb, 'vouchers', 'depreciation-voucher-1'), depreciationVoucher);
    assert.equal((await readRecord<{ localRevision: number }>(depreciationDb, 'meta', 'workspace_meta'))?.localRevision, 31);

    await assert.rejects(
      () => commitDepreciationOperationalTx({
        assetUpdates: [{ ...assetUpdate, expectedAccumulatedDepreciation: 1_000, accumulatedDepreciation: 1_500 }],
        voucher: { ...depreciationVoucher, id: 'stale-depreciation-voucher' } as never,
      }, { dbOverride: depreciationDb }),
      /تغییر کرده|مانده استهلاک/,
      'stale asset state must abort depreciation voucher and revision writes'
    );
    assert.equal(await readRecord(depreciationDb, 'vouchers', 'stale-depreciation-voucher'), undefined);
    assert.equal((await readRecord<{ localRevision: number }>(depreciationDb, 'meta', 'workspace_meta'))?.localRevision, 31);
    assert.equal((await readRecord<{ accumulatedDepreciation: number }>(depreciationDb, 'assets', 'asset-1'))?.accumulatedDepreciation, 1_500);
  } finally {
    depreciationDb.close();
  }

  const stockDb = await createDatabase([
    { name: 'meta', keyPath: 'key' },
    { name: 'products', keyPath: 'id' },
    { name: 'vouchers', keyPath: 'id' },
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = stockDb.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'workspace_meta', localRevision: 40 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Stock meta seed aborted'));
    });
    const adjustedProduct = { id: 'stock-product-1', stock: 12 };
    const stockVoucher = {
      id: 'stock-adjustment-voucher-1',
      lines: [{ debit: 300, credit: 0 }, { debit: 0, credit: 300 }],
    };
    assert.equal(await commitStockAdjustmentOperationalTx({
      updatedProducts: [adjustedProduct as never],
      voucher: stockVoucher as never,
    }, { dbOverride: stockDb }), true);
    assert.deepEqual(await readRecord(stockDb, 'products', 'stock-product-1'), adjustedProduct);
    assert.deepEqual(await readRecord(stockDb, 'vouchers', 'stock-adjustment-voucher-1'), stockVoucher);
    assert.equal((await readRecord<{ localRevision: number }>(stockDb, 'meta', 'workspace_meta'))?.localRevision, 41);
  } finally {
    stockDb.close();
  }

  console.log('Operational IndexedDB transaction integration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
