import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commitChequeStatusOperationalTx, commitDepreciationOperationalTx, commitInvoiceOperationalTx, commitStockAdjustmentOperationalTx } from '../src/lib/operationalDb';
import type { Cheque, FixedAsset, Invoice, Product, Voucher } from '../src/types/accounting';

/**
 * ACID Transactional In-Memory IndexedDB Simulator
 * Mirrors real browser IndexedDB multi-store transaction semantics:
 * - Writes go into a per-transaction staging buffer.
 * - On clean completion, staged writes atomically flush to persistent stores.
 * - On `tx.abort()` OR any store request error, staged writes are discarded (100% ROLLBACK).
 */
interface SimulatedIdbOptions {
  failOnStore?: 'products' | 'vouchers' | 'cheques' | 'invoices' | 'assets' | 'meta';
  failMode?: 'throw' | 'async_error';
  errorMessage?: string;
}

function createTransactionalIdbSimulator(initialData?: {
  products?: Product[];
  vouchers?: Voucher[];
  cheques?: Cheque[];
  invoices?: Invoice[];
  assets?: FixedAsset[];
  meta?: Array<{ key: string; [k: string]: unknown }>;
}) {
  const stores: Record<string, Map<string, any>> = {
    meta: new Map((initialData?.meta ?? []).map((m) => [m.key, structuredClone(m)])),
    products: new Map((initialData?.products ?? []).map((p) => [p.id, structuredClone(p)])),
    vouchers: new Map((initialData?.vouchers ?? []).map((v) => [v.id, structuredClone(v)])),
    cheques: new Map((initialData?.cheques ?? []).map((c) => [c.id, structuredClone(c)])),
    invoices: new Map((initialData?.invoices ?? []).map((i) => [i.id, structuredClone(i)])),
    assets: new Map((initialData?.assets ?? []).map((a) => [a.id, structuredClone(a)])),
  };

  let abortCount = 0;
  let commitCount = 0;
  let failureConfig: SimulatedIdbOptions = {};

  const setFailure = (cfg: SimulatedIdbOptions) => {
    failureConfig = cfg;
  };

  const db = {
    transaction(storeNames: string[], _mode: IDBTransactionMode) {
      for (const name of storeNames) {
        if (!stores[name]) {
          throw new Error(`Unknown objectStore: ${name}`);
        }
      }

      // Per-transaction shadow copies (staging) — discarded on abort!
      const staged: Record<string, Map<string, any>> = {};
      for (const name of storeNames) {
        staged[name] = new Map(
          Array.from(stores[name].entries()).map(([k, v]) => [k, structuredClone(v)])
        );
      }

      let aborted = false;
      let completed = false;
      let pendingAsyncOps = 0;
      let scheduledCommit = false;

      const tx: any = {
        error: null as Error | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        abort() {
          if (aborted || completed) return;
          aborted = true;
          abortCount += 1;
          // Discard staged writes completely (ROLLBACK)
          for (const name of storeNames) {
            staged[name].clear();
          }
          queueMicrotask(() => {
            tx.onabort?.();
          });
        },
        objectStore(name: string) {
          if (!staged[name]) {
            throw new Error(`Store ${name} not in transaction scope`);
          }
          const keyField = name === 'meta' ? 'key' : 'id';
          return {
            put(value: any) {
              if (aborted) {
                throw new Error('TransactionInactiveError: transaction already aborted');
              }
              const req: any = {
                result: undefined,
                error: null,
                onsuccess: null as (() => void) | null,
                onerror: null as (() => void) | null,
              };

              if (failureConfig.failOnStore === name) {
                const err = new Error(
                  failureConfig.errorMessage || `Simulated IndexedDB failure on store "${name}"`
                );
                if (failureConfig.failMode === 'throw') {
                  tx.error = err;
                  throw err;
                }
                // Async IDBRequest error -> triggers req.onerror & aborts entire tx
                pendingAsyncOps += 1;
                queueMicrotask(() => {
                  pendingAsyncOps -= 1;
                  req.error = err;
                  tx.error = err;
                  req.onerror?.();
                  if (!aborted) {
                    tx.abort();
                  }
                });
                return req;
              }

              const key = value?.[keyField];
              staged[name].set(key, structuredClone(value));
              pendingAsyncOps += 1;
              queueMicrotask(() => {
                pendingAsyncOps -= 1;
                if (aborted) return;
                req.result = key;
                req.onsuccess?.();
                maybeComplete();
              });
              return req;
            },
            get(key: string) {
              if (aborted) {
                throw new Error('TransactionInactiveError: transaction already aborted');
              }
              const req: any = {
                result: undefined,
                error: null,
                onsuccess: null as (() => void) | null,
                onerror: null as (() => void) | null,
              };
              pendingAsyncOps += 1;
              queueMicrotask(() => {
                pendingAsyncOps -= 1;
                if (aborted) return;
                req.result = staged[name].has(key) ? structuredClone(staged[name].get(key)) : undefined;
                req.onsuccess?.();
                maybeComplete();
              });
              return req;
            },
          };
        },
      };

      const maybeComplete = () => {
        if (aborted || completed || pendingAsyncOps > 0 || scheduledCommit) return;
        scheduledCommit = true;
        queueMicrotask(() => {
          scheduledCommit = false;
          if (aborted || completed || pendingAsyncOps > 0) return;
          completed = true;
          commitCount += 1;
          // Atomic commit: replace persistent stores with staged state
          for (const name of storeNames) {
            stores[name] = staged[name];
          }
          tx.oncomplete?.();
        });
      };

      return tx as IDBTransaction;
    },
    close() {
      // no-op for simulator
    },
  } as unknown as IDBDatabase;

  return {
    db,
    stores,
    setFailure,
    getStats: () => ({ abortCount, commitCount }),
  };
}

function makeSampleEntities() {
  const initialProduct: Product = {
    id: 'prod_1',
    ownerId: 'local_owner',
    sku: 'P-100',
    name: 'لپ‌تاپ صنعتی Apex',
    category: 'سخت‌افزار',
    warehouse: 'انبار مرکزی',
    unit: 'عدد',
    buyPrice: 20_000_000,
    sellPrice: 25_000_000,
    stock: 10,
    reorderPoint: 2,
    vatExempt: false,
    costLayers: [
      {
        layerId: 'lot_1',
        date: '1404/01/01',
        sourceRef: 'opening_1',
        originalQty: 10,
        remainingQty: 10,
        unitCostIrr: 20_000_000,
        totalCostIrr: 200_000_000,
      },
    ],
    inventoryValueIrr: 200_000_000,
  };

  const updatedProduct: Product = {
    ...initialProduct,
    stock: 8,
    costLayers: [
      {
        layerId: 'lot_1',
        date: '1404/01/01',
        sourceRef: 'opening_1',
        originalQty: 10,
        remainingQty: 8,
        unitCostIrr: 20_000_000,
        totalCostIrr: 160_000_000,
      },
    ],
    inventoryValueIrr: 160_000_000,
  };

  const balancedVoucher: Voucher = {
    id: 'vch_sale_1',
    ownerId: 'local_owner',
    voucherNumber: 101,
    date: '1404/02/10',
    description: 'ثبت فاکتور فروش #F-1001',
    status: 'permanent',
    voucherType: 'sales',
    totalDebit: 50_000_000,
    totalCredit: 50_000_000,
    lines: [
      { accountCode: '10301', accountTitle: 'حساب‌های دریافتنی', description: 'فروش', debit: 50_000_000, credit: 0 },
      { accountCode: '40101', accountTitle: 'درآمد فروش کالا', description: 'فروش', debit: 0, credit: 50_000_000 },
    ],
  };

  const cheque: Cheque = {
    id: 'chq_1',
    ownerId: 'local_owner',
    serial: '90012345',
    sayadiId: '1234567890123456',
    direction: 'receivable',
    partyId: 'party_1',
    partyName: 'شرکت آلفا',
    bankName: 'بانک ملت',
    amount: 50_000_000,
    issueDate: '1404/02/10',
    dueDate: '1404/03/10',
    status: 'in_box',
    notes: 'بابت فاکتور F-1001',
  };

  const invoice: Invoice = {
    id: 'inv_1',
    ownerId: 'local_owner',
    invoiceNumber: 'F-1001',
    invoiceType: 'sale',
    date: '1404/02/10',
    partyId: 'party_1',
    partyName: 'شرکت آلفا',
    warehouse: 'انبار مرکزی',
    status: 'issued',
    items: [
      {
        productId: 'prod_1',
        sku: 'P-100',
        productName: 'لپ‌تاپ صنعتی Apex',
        unit: 'عدد',
        quantity: 2,
        unitPrice: 25_000_000,
        discount: 0,
        vatAmount: 0,
        lineTotal: 50_000_000,
      },
    ],
    subtotal: 50_000_000,
    discount: 0,
    vatAmount: 0,
    grandTotal: 50_000_000,
    paidCash: 0,
    paidBank: 0,
    paidCheque: 50_000_000,
    creditAmount: 0,
    voucherId: 'vch_sale_1',
  };

  return { initialProduct, updatedProduct, balancedVoucher, cheque, invoice };
}

async function runTests() {
  const root = process.cwd();

  // =========================================================================
  // 1. STATIC & GUARD AUDIT: useDualCloudSync.ts & useLocalFirstMeshSync.ts
  // =========================================================================
  const dualCloudSrc = fs.readFileSync(path.join(root, 'src/hooks/useDualCloudSync.ts'), 'utf8');
  const meshSyncSrc = fs.readFileSync(path.join(root, 'src/hooks/useLocalFirstMeshSync.ts'), 'utf8');
  const viteConfigSrc = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  const accountingCtxSrc = fs.readFileSync(path.join(root, 'src/context/AccountingContext.tsx'), 'utf8');

  const forbiddenDirectNetworkPatterns: Array<{ label: string; regex: RegExp }> = [
    { label: 'raw fetch()', regex: /\bfetch\s*\(/ },
    { label: 'XMLHttpRequest', regex: /\bXMLHttpRequest\b/ },
    { label: 'axios', regex: /\baxios\b/ },
    { label: 'direct WebSocket', regex: /\bnew\s+WebSocket\b/ },
    { label: 'EventSource', regex: /\bEventSource\b/ },
    { label: 'direct /api/ endpoint string', regex: /['"`]\/api\// },
    { label: 'hardcoded external http(s) URL', regex: /['"`]https?:\/\// },
  ];

  for (const { label, regex } of forbiddenDirectNetworkPatterns) {
    assert.equal(
      regex.test(dualCloudSrc),
      false,
      `useDualCloudSync.ts must NOT contain ${label}`
    );
    assert.equal(
      regex.test(meshSyncSrc),
      false,
      `useLocalFirstMeshSync.ts must NOT contain ${label}`
    );
  }

  // Verify operatingMode-aware `isOnline` guards in useLocalFirstMeshSync.ts
  assert.match(
    meshSyncSrc,
    /if\s*\(\s*!selectedPeerId\s*\|\|\s*!isOnline\s*\)/,
    'useLocalFirstMeshSync.ts must skip PeerMeshConnector instantiation when offline or in local mode'
  );
  assert.match(
    meshSyncSrc,
    /const handleOnline = \(\) => \{\s*if \(!isOnline \|\| !connectorRef\.current\) return;/,
    'useLocalFirstMeshSync.ts handleOnline must respect isOnline (operatingMode !== local)'
  );
  assert.match(
    meshSyncSrc,
    /const handleVisibility = \(\) => \{\s*if \(!isOnline \|\| !connectorRef\.current\) return;/,
    'useLocalFirstMeshSync.ts handleVisibility must respect isOnline'
  );

  // Verify strict `isOnline` guards on all network actions in useDualCloudSync.ts
  for (const fnName of [
    'setupIndependentSupabase',
    'loginIndependentSupabase',
    'logoutIndependentSupabase',
    'removeFirebaseBackup',
    'runServerTest',
  ]) {
    const idx = dualCloudSrc.indexOf(`const ${fnName} = useCallback`);
    assert.ok(idx !== -1, `Expected ${fnName} in useDualCloudSync.ts`);
    const snippet = dualCloudSrc.slice(idx, idx + 450);
    assert.match(
      snippet,
      /\bisOnline\b/,
      `${fnName} in useDualCloudSync.ts must guard network execution with isOnline`
    );
  }

  // Verify defined Workbox caches in vite.config.ts
  assert.match(viteConfigSrc, /apex-live-fx-cache-v1/, 'Workbox live-fx cache must be defined');
  assert.match(viteConfigSrc, /apex-local-assets-cache-v1/, 'Workbox local assets cache must be defined');
  assert.match(viteConfigSrc, /woff2/, 'Workbox precache must include local woff2 fonts');

  // Verify all 3 local invoice lifecycle operations in AccountingContext.tsx use commitInvoiceOperationalTx
  const createInvoiceIdx = accountingCtxSrc.indexOf('const createInvoice = useCallback');
  const cancelInvoiceIdx = accountingCtxSrc.indexOf('const cancelInvoice = useCallback');
  const convertProformaIdx = accountingCtxSrc.indexOf('const convertProformaToSale = useCallback');
  assert.ok(createInvoiceIdx !== -1 && cancelInvoiceIdx !== -1 && convertProformaIdx !== -1);

  assert.match(
    accountingCtxSrc.slice(createInvoiceIdx, cancelInvoiceIdx),
    /await commitInvoiceOperationalTx\(/,
    'createInvoice must commit atomically via commitInvoiceOperationalTx'
  );
  assert.match(
    accountingCtxSrc.slice(cancelInvoiceIdx, convertProformaIdx),
    /await commitInvoiceOperationalTx\(/,
    'cancelInvoice must commit atomically via commitInvoiceOperationalTx'
  );
  assert.match(
    accountingCtxSrc.slice(convertProformaIdx, convertProformaIdx + 22000),
    /await commitInvoiceOperationalTx\(/,
    'convertProformaToSale must commit atomically via commitInvoiceOperationalTx'
  );

  const updateChequeStatusIdx = accountingCtxSrc.indexOf('const updateChequeStatus = useCallback');
  assert.ok(updateChequeStatusIdx !== -1, 'updateChequeStatus must exist');
  assert.match(
    accountingCtxSrc.slice(updateChequeStatusIdx, updateChequeStatusIdx + 14000),
    /await commitChequeStatusOperationalTx\(/,
    'offline cheque status changes must atomically persist cheque and ledger voucher'
  );

  const payrollIdx = accountingCtxSrc.indexOf('const postMonthlyPayrollVoucher = useCallback');
  const payrollEnd = accountingCtxSrc.indexOf('const paySalariesVoucher = useCallback', payrollIdx);
  assert.ok(payrollIdx !== -1 && payrollEnd > payrollIdx);
  const payrollBody = accountingCtxSrc.slice(payrollIdx, payrollEnd);
  assert.match(payrollBody, /Number\.isSafeInteger\(totalExpense\)/);
  assert.match(payrollBody, /totalExpense !== totalNet \+ totalInsurance \+ totalTax/);
  assert.match(payrollBody, /ماه حقوق باید یک عنوان معتبر/);

  const depreciationIdx = accountingCtxSrc.indexOf('const postDepreciationVoucher = useCallback');
  const depreciationEnd = accountingCtxSrc.indexOf('const addCostCenter = useCallback', depreciationIdx);
  assert.ok(depreciationIdx !== -1 && depreciationEnd > depreciationIdx);
  const depreciationBody = accountingCtxSrc.slice(depreciationIdx, depreciationEnd);
  const offlineDepreciationBranch = depreciationBody.slice(depreciationBody.lastIndexOf('} else {'));
  assert.match(
    offlineDepreciationBranch,
    /commitDepreciationOperationalTx/,
    'offline depreciation must use one IndexedDB transaction for asset balances and the permanent voucher'
  );
  const yearEndIdx = accountingCtxSrc.indexOf('const runYearEndClosing = useCallback');
  const yearEndEnd = accountingCtxSrc.indexOf('// ---------------- MULTI-CURRENCY & DAILY EXCHANGE RATES', yearEndIdx);
  assert.ok(yearEndIdx !== -1 && yearEndEnd > yearEndIdx);
  const yearEndBody = accountingCtxSrc.slice(yearEndIdx, yearEndEnd);
  assert.match(yearEndBody, /existingClosing && options\?\.createNextYearOpening && !existingOpening/);
  assert.match(yearEndBody, /existingOpening && !existingClosing/);
  console.log('✓ 1a. Static audit passed for year-end recovery mismatch fail-closed guards');

  console.log('✓ 1. Static audit passed for offline guards, atomic financial operations and atomic depreciation');

  // =========================================================================
  // 2. ATOMIC COMMIT HAPPY PATH (Create Invoice: Inventory + Ledger + Treasury + Invoice)
  // =========================================================================
  const { initialProduct, updatedProduct, balancedVoucher, cheque, invoice } = makeSampleEntities();

  // =========================================================================
  // 2. ATOMIC STOCK ADJUSTMENT VALIDATION + ROLLBACK
  // =========================================================================
  const stockSim = createTransactionalIdbSimulator({
    products: [initialProduct],
    meta: [{ key: 'workspace_meta', localRevision: 12 }],
  });
  const stockCommitted = await commitStockAdjustmentOperationalTx(
    { updatedProducts: [updatedProduct], voucher: balancedVoucher },
    { dbOverride: stockSim.db }
  );
  assert.equal(stockCommitted, true);
  assert.equal(stockSim.stores.products.get('prod_1').stock, 8);
  assert.equal(stockSim.stores.vouchers.get('vch_sale_1').id, 'vch_sale_1');
  assert.equal(stockSim.stores.meta.get('workspace_meta').localRevision, 13);
  console.log('✓ 2. Stock adjustment commits inventory, ledger and revision atomically');

  const stockRollbackSim = createTransactionalIdbSimulator({
    products: [initialProduct],
    meta: [{ key: 'workspace_meta', localRevision: 20 }],
  });
  stockRollbackSim.setFailure({
    failOnStore: 'vouchers',
    failMode: 'async_error',
    errorMessage: 'ConstraintError: stock voucher write rejected',
  });
  await assert.rejects(
    () => commitStockAdjustmentOperationalTx(
      { updatedProducts: [updatedProduct], voucher: balancedVoucher },
      { dbOverride: stockRollbackSim.db }
    ),
    /stock voucher write rejected/
  );
  assert.equal(stockRollbackSim.getStats().abortCount, 1);
  assert.equal(stockRollbackSim.stores.products.get('prod_1').stock, 10);
  assert.equal(stockRollbackSim.stores.vouchers.size, 0);
  assert.equal(stockRollbackSim.stores.meta.get('workspace_meta').localRevision, 20);
  console.log('✓ 2a. Stock adjustment rolls back inventory when ledger persistence fails');

  const invalidStockVoucher: Voucher = {
    ...balancedVoucher,
    id: 'vch_invalid_stock',
    lines: [
      { accountCode: '10301', accountTitle: 'انبار', description: 'نامعتبر', debit: -1, credit: 0 },
      { accountCode: '40101', accountTitle: 'تعدیل', description: 'نامعتبر', debit: 0, credit: 1 },
    ],
  };
  await assert.rejects(
    () => commitStockAdjustmentOperationalTx(
      { updatedProducts: [updatedProduct], voucher: invalidStockVoucher },
      { dbOverride: stockSim.db }
    ),
    /ATOMIC_STOCK_INVALID_VOUCHER_LINE/
  );
  assert.equal(stockSim.stores.products.get('prod_1').stock, 8, 'Invalid voucher must not change stock');
  console.log('✓ 2b. Invalid stock voucher is rejected before any write');

  const transitionedCheque = { ...cheque, status: 'endorsed' as const };
  const chequeVoucher: Voucher = { ...balancedVoucher, id: 'vch_cheque_transition' };
  const chequeTxSim = createTransactionalIdbSimulator({
    cheques: [cheque],
    meta: [{ key: 'workspace_meta', localRevision: 30 }],
  });
  const chequeTransitionOk = await commitChequeStatusOperationalTx(
    { cheque: transitionedCheque, expectedStatus: cheque.status, voucher: chequeVoucher },
    { dbOverride: chequeTxSim.db }
  );
  assert.equal(chequeTransitionOk, true);
  assert.equal(chequeTxSim.stores.cheques.get('chq_1').status, 'endorsed');
  assert.equal(chequeTxSim.stores.vouchers.get('vch_cheque_transition').id, 'vch_cheque_transition');
  assert.equal(chequeTxSim.stores.meta.get('workspace_meta').localRevision, 31);
  console.log('✓ 2c. Cheque status and permanent ledger voucher commit atomically');

  const chequeRollbackSim = createTransactionalIdbSimulator({
    cheques: [cheque],
    meta: [{ key: 'workspace_meta', localRevision: 40 }],
  });
  chequeRollbackSim.setFailure({
    failOnStore: 'vouchers',
    failMode: 'async_error',
    errorMessage: 'ConstraintError: cheque transition voucher rejected',
  });
  await assert.rejects(
    () => commitChequeStatusOperationalTx(
      { cheque: transitionedCheque, expectedStatus: cheque.status, voucher: chequeVoucher },
      { dbOverride: chequeRollbackSim.db }
    ),
    /cheque transition voucher rejected/
  );
  assert.equal(chequeRollbackSim.stores.cheques.get('chq_1').status, cheque.status);
  assert.equal(chequeRollbackSim.stores.vouchers.size, 0);
  assert.equal(chequeRollbackSim.stores.meta.get('workspace_meta').localRevision, 40);
  console.log('✓ 2d. Failed cheque voucher write rolls back the status transition');

  const staleChequeSim = createTransactionalIdbSimulator({
    cheques: [{ ...cheque, status: 'cleared' as const }],
    meta: [{ key: 'workspace_meta', localRevision: 50 }],
  });
  await assert.rejects(
    () => commitChequeStatusOperationalTx(
      { cheque: transitionedCheque, expectedStatus: cheque.status, voucher: chequeVoucher },
      { dbOverride: staleChequeSim.db }
    ),
    /ATOMIC_CHEQUE_STALE_STATUS/
  );
  assert.equal(staleChequeSim.stores.cheques.get('chq_1').status, 'cleared');
  assert.equal(staleChequeSim.stores.vouchers.size, 0);
  assert.equal(staleChequeSim.stores.meta.get('workspace_meta').localRevision, 50);
  console.log('✓ 2e. Stale local cheque transitions are rejected without overwriting newer status');

  const invalidInvoiceVoucher: Voucher = {
    ...balancedVoucher,
    id: 'vch_negative_invoice',
    lines: [
      { accountCode: '10301', accountTitle: 'دریافتنی', description: 'منفی', debit: -50_000_000, credit: 0 },
      { accountCode: '40101', accountTitle: 'فروش', description: 'منفی', debit: 0, credit: -50_000_000 },
    ],
  };
  const invalidInvoiceSim = createTransactionalIdbSimulator({
    products: [initialProduct],
    meta: [{ key: 'workspace_meta', localRevision: 4 }],
  });
  await assert.rejects(
    () => commitInvoiceOperationalTx(
      { updatedProducts: [updatedProduct], voucher: invalidInvoiceVoucher, invoice },
      { dbOverride: invalidInvoiceSim.db }
    ),
    /ATOMIC_ROLLBACK_INVALID_VOUCHER_LINE/
  );
  assert.equal(invalidInvoiceSim.stores.products.get('prod_1').stock, 10);
  assert.equal(invalidInvoiceSim.stores.vouchers.size, 0);
  assert.equal(invalidInvoiceSim.stores.invoices.size, 0);
  assert.equal(invalidInvoiceSim.stores.meta.get('workspace_meta').localRevision, 4);
  console.log('✓ 2c. Invoice rejects negative ledger lines before any inventory or document write');

  const duplicateProductSim = createTransactionalIdbSimulator({ products: [initialProduct] });
  await assert.rejects(
    () => commitInvoiceOperationalTx(
      { updatedProducts: [updatedProduct, updatedProduct], invoice },
      { dbOverride: duplicateProductSim.db }
    ),
    /ATOMIC_ROLLBACK_INVALID_PRODUCT/
  );
  assert.equal(duplicateProductSim.stores.products.get('prod_1').stock, 10);
  assert.equal(duplicateProductSim.stores.invoices.size, 0);
  console.log('✓ 2d. Invoice rejects duplicate product mutations before writes');

  const duplicateChequeSim = createTransactionalIdbSimulator();
  await assert.rejects(
    () => commitInvoiceOperationalTx(
      { updatedProducts: [], cheques: [cheque, cheque], invoice },
      { dbOverride: duplicateChequeSim.db }
    ),
    /ATOMIC_ROLLBACK_INVALID_CHEQUE/
  );
  assert.equal(duplicateChequeSim.stores.cheques.size, 0);
  assert.equal(duplicateChequeSim.stores.invoices.size, 0);
  console.log('✓ 2e. Invoice rejects duplicate treasury cheque IDs before writes');

  const overflowRevisionSim = createTransactionalIdbSimulator({
    products: [initialProduct],
    meta: [{ key: 'workspace_meta', localRevision: Number.MAX_SAFE_INTEGER }],
  });
  await assert.rejects(
    () => commitInvoiceOperationalTx(
      { updatedProducts: [updatedProduct], invoice },
      { dbOverride: overflowRevisionSim.db }
    ),
    /ATOMIC_ROLLBACK_INVALID_REVISION/
  );
  assert.equal(overflowRevisionSim.stores.products.get('prod_1').stock, 10);
  assert.equal(overflowRevisionSim.stores.invoices.size, 0);
  console.log('✓ 2f. Invoice rejects unsafe workspace revision without partial writes');

  const sim = createTransactionalIdbSimulator({ products: [initialProduct] });

  const okCreate = await commitInvoiceOperationalTx(
    {
      updatedProducts: [updatedProduct],
      voucher: balancedVoucher,
      cheque,
      invoice,
    },
    { dbOverride: sim.db }
  );

  assert.equal(okCreate, true);
  assert.equal(sim.stores.products.get('prod_1').stock, 8);
  assert.equal(sim.stores.vouchers.get('vch_sale_1').voucherNumber, 101);
  assert.equal(sim.stores.cheques.get('chq_1').amount, 50_000_000);
  assert.equal(sim.stores.invoices.get('inv_1').invoiceNumber, 'F-1001');
  assert.equal(sim.stores.meta.get('workspace_meta').localRevision, 1);
  console.log('✓ 2. Atomic invoice creation committed all 5 stores in a single transaction');

  // =========================================================================
  // 3. ATOMIC MULTI-CHEQUE CANCELLATION HAPPY PATH
  // =========================================================================
  const reversalVoucher: Voucher = {
    ...balancedVoucher,
    id: 'vch_rev_1',
    voucherNumber: 102,
    description: 'سند معکوس ابطال فاکتور #F-1001',
    lines: [
      { accountCode: '40101', accountTitle: 'درآمد فروش کالا', description: 'ابطال', debit: 50_000_000, credit: 0 },
      { accountCode: '10301', accountTitle: 'حساب‌های دریافتنی', description: 'ابطال', debit: 0, credit: 50_000_000 },
    ],
  };

  const okCancel = await commitInvoiceOperationalTx(
    {
      updatedProducts: [initialProduct],
      voucher: reversalVoucher,
      cheques: [{ ...cheque, status: 'cancelled' }],
      invoice: { ...invoice, status: 'cancelled' },
    },
    { dbOverride: sim.db }
  );

  assert.equal(okCancel, true);
  assert.equal(sim.stores.products.get('prod_1').stock, 10, 'Stock must be restored atomically');
  assert.equal(sim.stores.vouchers.has('vch_rev_1'), true, 'Reversal voucher must persist');
  assert.equal(sim.stores.cheques.get('chq_1').status, 'cancelled', 'Cheque must be cancelled');
  assert.equal(sim.stores.invoices.get('inv_1').status, 'cancelled', 'Invoice must be cancelled');
  assert.equal(sim.stores.meta.get('workspace_meta').localRevision, 2);
  console.log('✓ 3. Atomic invoice cancellation committed inventory restore + reversal voucher + cheque cancel');

  // =========================================================================
  // 4. REAL ROLLBACK TEST A: Synchronous failure on `cheques` store AFTER `products` & `vouchers` wrote
  // =========================================================================
  const simRollbackSync = createTransactionalIdbSimulator({
    products: [initialProduct],
    meta: [{ key: 'workspace_meta', localRevision: 5 }],
  });
  simRollbackSync.setFailure({
    failOnStore: 'cheques',
    failMode: 'throw',
    errorMessage: 'QuotaExceededError: Treasury cheque store full',
  });

  await assert.rejects(
    () =>
      commitInvoiceOperationalTx(
        {
          updatedProducts: [updatedProduct],
          voucher: balancedVoucher,
          cheque,
          invoice,
        },
        { dbOverride: simRollbackSync.db }
      ),
    /QuotaExceededError/
  );

  assert.equal(simRollbackSync.getStats().abortCount, 1, 'tx.abort() must have fired');
  assert.equal(simRollbackSync.stores.products.get('prod_1').stock, 10, 'ROLLBACK: Product stock must remain 10');
  assert.equal(simRollbackSync.stores.vouchers.size, 0, 'ROLLBACK: Voucher must NOT be persisted');
  assert.equal(simRollbackSync.stores.cheques.size, 0, 'ROLLBACK: Cheque must NOT be persisted');
  assert.equal(simRollbackSync.stores.invoices.size, 0, 'ROLLBACK: Invoice must NOT be persisted');
  assert.equal(
    simRollbackSync.stores.meta.get('workspace_meta').localRevision,
    5,
    'ROLLBACK: localRevision must remain 5'
  );
  console.log('✓ 4. ROLLBACK verified on synchronous Treasury (cheques) store failure — 0 partial writes');

  // =========================================================================
  // 5. REAL ROLLBACK TEST B: Async IDBRequest error on `invoices` store AFTER `products`, `vouchers`, `cheques` wrote
  // =========================================================================
  const simRollbackAsync = createTransactionalIdbSimulator({
    products: [initialProduct],
    meta: [{ key: 'workspace_meta', localRevision: 9 }],
  });
  simRollbackAsync.setFailure({
    failOnStore: 'invoices',
    failMode: 'async_error',
    errorMessage: 'ConstraintError: Async invoice write rejected by IndexedDB',
  });

  await assert.rejects(
    () =>
      commitInvoiceOperationalTx(
        {
          updatedProducts: [updatedProduct],
          voucher: balancedVoucher,
          cheque,
          invoice,
        },
        { dbOverride: simRollbackAsync.db }
      ),
    /ConstraintError/
  );

  assert.equal(simRollbackAsync.getStats().abortCount, 1, 'tx.abort() must have fired on async store error');
  assert.equal(simRollbackAsync.stores.products.get('prod_1').stock, 10, 'ROLLBACK: Product stock unchanged');
  assert.equal(simRollbackAsync.stores.vouchers.size, 0, 'ROLLBACK: Voucher rolled back');
  assert.equal(simRollbackAsync.stores.cheques.size, 0, 'ROLLBACK: Cheque rolled back');
  assert.equal(simRollbackAsync.stores.invoices.size, 0, 'ROLLBACK: Invoice rolled back');
  assert.equal(
    simRollbackAsync.stores.meta.get('workspace_meta').localRevision,
    9,
    'ROLLBACK: localRevision unchanged'
  );
  console.log('✓ 5. ROLLBACK verified on async Invoice store failure — all prior writes aborted cleanly');

  // =========================================================================
  // 6. REAL ROLLBACK TEST C: Unbalanced Double-Entry Voucher aborts transaction after Product write
  // =========================================================================
  const simUnbalanced = createTransactionalIdbSimulator({
    products: [initialProduct],
    meta: [{ key: 'workspace_meta', localRevision: 3 }],
  });
  const unbalancedVoucher: Voucher = {
    ...balancedVoucher,
    id: 'vch_bad',
    totalDebit: 50_000_000,
    totalCredit: 49_000_000,
    lines: [
      { accountCode: '10301', accountTitle: 'دریافتنی', description: 'خطا', debit: 50_000_000, credit: 0 },
      { accountCode: '40101', accountTitle: 'فروش', description: 'خطا', debit: 0, credit: 49_000_000 },
    ],
  };

  await assert.rejects(
    () =>
      commitInvoiceOperationalTx(
        {
          updatedProducts: [updatedProduct],
          voucher: unbalancedVoucher,
          cheque,
          invoice,
        },
        { dbOverride: simUnbalanced.db }
      ),
    /ATOMIC_ROLLBACK_UNBALANCED_VOUCHER/
  );

  assert.equal(simUnbalanced.getStats().abortCount, 1);
  assert.equal(simUnbalanced.stores.products.get('prod_1').stock, 10, 'ROLLBACK: Product deduction rolled back');
  assert.equal(simUnbalanced.stores.vouchers.size, 0);
  assert.equal(simUnbalanced.stores.cheques.size, 0);
  assert.equal(simUnbalanced.stores.invoices.size, 0);
  assert.equal(simUnbalanced.stores.meta.get('workspace_meta').localRevision, 3);
  console.log('✓ 6. ROLLBACK verified on unbalanced double-entry voucher — zero inventory/treasury drift');


  // =========================================================================
  // 7. ATOMIC FIXED-ASSET DEPRECIATION (assets + permanent voucher + revision)
  // =========================================================================
  const asset: FixedAsset = {
    id: 'asset_1',
    ownerId: 'local_owner',
    assetCode: 'FA-001',
    title: 'تجهیزات اداری',
    purchaseDate: '1404/01/01',
    purchaseCost: 120_000_000,
    salvageValue: 12_000_000,
    usefulLifeYears: 5,
    accumulatedDepreciation: 10_000_000,
  };
  const depreciationVoucher: Voucher = {
    ...balancedVoucher,
    id: 'vch_dep_1',
    voucherNumber: 103,
    voucherType: 'depreciation',
    referenceId: 'depreciation:1405:آبان',
    totalDebit: 1_800_000,
    totalCredit: 1_800_000,
    lines: [
      { accountCode: '80301', accountTitle: 'هزینه استهلاک', description: 'استهلاک', debit: 1_800_000, credit: 0 },
      { accountCode: '20201', accountTitle: 'استهلاک انباشته', description: 'استهلاک', debit: 0, credit: 1_800_000 },
    ],
  };
  const depreciationSim = createTransactionalIdbSimulator({
    assets: [asset],
    meta: [{ key: 'workspace_meta', localRevision: 12 }],
  });
  const depreciationCommitted = await commitDepreciationOperationalTx({
    assetUpdates: [{
      id: asset.id,
      expectedAccumulatedDepreciation: 10_000_000,
      expectedPurchaseCost: 120_000_000,
      expectedSalvageValue: 12_000_000,
      expectedUsefulLifeYears: 5,
      expectedPurchaseDate: '1404/01/01',
      depreciationAmount: 1_800_000,
      accumulatedDepreciation: 11_800_000,
    }],
    voucher: depreciationVoucher,
  }, { dbOverride: depreciationSim.db });
  assert.equal(depreciationCommitted, true);
  assert.equal(depreciationSim.stores.assets.get(asset.id).accumulatedDepreciation, 11_800_000);
  assert.equal(depreciationSim.stores.vouchers.get(depreciationVoucher.id).referenceId, depreciationVoucher.referenceId);
  assert.equal(depreciationSim.stores.meta.get('workspace_meta').localRevision, 13);
  console.log('✓ 7. Depreciation asset balances, permanent voucher and workspace revision commit atomically');

  const depreciationRollbackSim = createTransactionalIdbSimulator({
    assets: [asset],
    meta: [{ key: 'workspace_meta', localRevision: 20 }],
  });
  depreciationRollbackSim.setFailure({
    failOnStore: 'vouchers',
    failMode: 'async_error',
    errorMessage: 'ConstraintError: depreciation voucher write rejected',
  });
  await assert.rejects(
    () => commitDepreciationOperationalTx({
      assetUpdates: [{
        id: asset.id,
        expectedAccumulatedDepreciation: 10_000_000,
        expectedPurchaseCost: 120_000_000,
        expectedSalvageValue: 12_000_000,
        expectedUsefulLifeYears: 5,
        expectedPurchaseDate: '1404/01/01',
        depreciationAmount: 1_800_000,
        accumulatedDepreciation: 11_800_000,
      }],
      voucher: { ...depreciationVoucher, id: 'vch_dep_rollback' },
    }, { dbOverride: depreciationRollbackSim.db }),
    /depreciation voucher write rejected/
  );
  assert.equal(depreciationRollbackSim.getStats().abortCount, 1);
  assert.equal(depreciationRollbackSim.stores.assets.get(asset.id).accumulatedDepreciation, 10_000_000);
  assert.equal(depreciationRollbackSim.stores.vouchers.size, 0);
  assert.equal(depreciationRollbackSim.stores.meta.get('workspace_meta').localRevision, 20);
  console.log('✓ 7a. Failed depreciation voucher write rolls back asset balance and revision');

  const staleDepreciationSim = createTransactionalIdbSimulator({
    assets: [{ ...asset, accumulatedDepreciation: 10_500_000 }],
    meta: [{ key: 'workspace_meta', localRevision: 21 }],
  });
  await assert.rejects(
    () => commitDepreciationOperationalTx({
      assetUpdates: [{
        id: asset.id,
        expectedAccumulatedDepreciation: 10_000_000,
        expectedPurchaseCost: 120_000_000,
        expectedSalvageValue: 12_000_000,
        expectedUsefulLifeYears: 5,
        expectedPurchaseDate: '1404/01/01',
        depreciationAmount: 1_800_000,
        accumulatedDepreciation: 11_800_000,
      }],
      voucher: { ...depreciationVoucher, id: 'vch_dep_stale' },
    }, { dbOverride: staleDepreciationSim.db }),
    /ATOMIC_DEPRECIATION_STALE_OR_INVALID_ASSET/
  );
  assert.equal(staleDepreciationSim.stores.assets.get(asset.id).accumulatedDepreciation, 10_500_000);
  assert.equal(staleDepreciationSim.stores.vouchers.size, 0);
  assert.equal(staleDepreciationSim.stores.meta.get('workspace_meta').localRevision, 21);
  console.log('✓ 7b. Stale depreciation balances are rejected without overwriting newer asset state');

  console.log('\nALL OFFLINE-FIRST & ATOMIC INDEXEDDB ROLLBACK AUDIT TESTS PASSED ✅');
}

runTests().catch((err) => {
  console.error('❌ Offline-First & Atomicity Audit FAILED:', err);
  process.exit(1);
});
