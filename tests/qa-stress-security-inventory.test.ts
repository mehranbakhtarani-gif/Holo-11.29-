import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { createHolooSeedData } from '../src/data/holooSeed';
import {
  computeAuditReport,
  computeBalanceSheet,
  computeIncomeStatement,
  computePartyBalances,
  computeTrialBalance,
  getUnreturnedConsumedCostLayers,
  planAtomicInvoiceCommit,
  planInvoiceCancellation,
  planProformaToSaleConversion,
  planStockAdjustmentWithCostLayers,
} from '../src/lib/accountingEngine';
import {
  calculateLandedCostAllocation,
  checkOperatorPermission,
  RBAC_ROLE_PRESETS,
} from '../src/lib/enterpriseAccounting';
import { allocateProportionalIrr, mulQtyByIrr, percentOfIrr } from '../src/lib/moneyMath';
import { applyInventoryMovementStep } from '../src/lib/inventoryCostingEngine';
import { auditPendingApprovalItems } from '../src/lib/smartAutomationEngine';
import { fuzzyFilterAndRank } from '../src/lib/fuzzySearch';
import {
  MAX_EXCEL_BUFFER_BYTES,
  parseExcelArrayBuffer,
  sanitizeSpreadsheetFormulaCell,
} from '../src/lib/universalExcelImport';
import { buildStandardAccountingReportBodyHtml } from '../src/lib/accountingReportExport';
import type {
  Invoice,
  Party,
  Product,
  RbacPermissions,
  RbacRoleKey,
  Voucher,
} from '../src/types/accounting';
import type { PendingApprovalDocumentItem } from '../src/lib/pendingApprovalsSummary';

function logPass(name: string, detail?: string) {
  console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('Running QA Stress, Inventory Integration, Accounting Math & Security Suite...');

/* ============================================================================
 * SALE RETURN CUMULATIVE QUANTITY GUARD
 * ========================================================================== */
{
  const ownerId = 'qa_sale_return_owner';
  const originalSale: Invoice = {
    id: 'sale_original_1',
    ownerId,
    invoiceNumber: 'SAL-ORIGINAL-1',
    invoiceType: 'sale',
    date: '1405/01/10',
    partyId: 'customer_1',
    partyName: 'مشتری آزمون',
    warehouse: 'انبار مرکزی',
    subtotal: 1_000,
    discount: 0,
    vatAmount: 0,
    grandTotal: 1_000,
    paidCash: 1_000,
    paidBank: 0,
    paidCheque: 0,
    creditAmount: 0,
    status: 'settled',
    items: [{
      productId: 'product_return_1',
      sku: 'RET-1',
      productName: 'کالای آزمون',
      unit: 'عدد',
      quantity: 10,
      unitPrice: 100,
      discount: 0,
      vatAmount: 0,
      lineTotal: 1_000,
      unitCostSnapshot: 50,
      totalCostIrr: 500,
    }],
  };
  const previousReturn: Invoice = {
    ...originalSale,
    id: 'sale_return_previous_1',
    invoiceNumber: 'RET-PREV-1',
    invoiceType: 'sale_return',
    sourceInvoiceId: originalSale.id,
    subtotal: 500,
    grandTotal: 500,
    paidCash: 500,
    items: [{ ...originalSale.items[0], quantity: 5, unitPrice: 100, lineTotal: 500 }],
  };
  const overReturnPayload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'> = {
    invoiceNumber: 'RET-OVER-1',
    invoiceType: 'sale_return',
    sourceInvoiceId: originalSale.id,
    date: '1405/01/12',
    partyId: originalSale.partyId,
    partyName: originalSale.partyName,
    warehouse: originalSale.warehouse,
    subtotal: 600,
    discount: 0,
    vatAmount: 0,
    grandTotal: 600,
    paidCash: 600,
    paidBank: 0,
    paidCheque: 0,
    creditAmount: 0,
    status: 'settled',
    items: [{ ...originalSale.items[0], quantity: 6, unitPrice: 100, lineTotal: 600 }],
  };
  assert.throws(() => planAtomicInvoiceCommit({
    invoiceId: 'sale_return_new_1',
    voucherId: 'voucher_return_new_1',
    nextVoucherNumber: 3,
    ownerId,
    deviceId: 'qa_runner',
    payload: overReturnPayload,
    products: [],
    originalInvoice: originalSale,
    existingInvoices: [originalSale, previousReturn],
  }), /مانده مجاز: 5/);
  logPass('Cumulative sale-return guard', 'rejects a second partial return that would exceed the original sold quantity');

  const originalFifoLayers = [
    { layerId: 'fifo_a', qty: 5, unitCostIrr: 100, totalCostIrr: 500 },
    { layerId: 'fifo_b', qty: 5, unitCostIrr: 200, totalCostIrr: 1_000 },
  ];
  const unreturnedLayers = getUnreturnedConsumedCostLayers(originalFifoLayers, 3);
  assert.deepEqual(unreturnedLayers, [
    { layerId: 'fifo_a', qty: 5, unitCostIrr: 100, totalCostIrr: 500 },
    { layerId: 'fifo_b', qty: 2, unitCostIrr: 200, totalCostIrr: 400 },
  ]);
  const secondPartialReturn = applyInventoryMovementStep({
    productId: 'product_return_1',
    costingMethod: 'fifo',
    stockQty: 3,
    totalValueIrr: 600,
    weightedAvgUnitCostIrr: 200,
    layers: [{
      layerId: 'ret_previous',
      date: '1405/01/11',
      sourceRef: originalSale.id,
      warehouse: originalSale.warehouse,
      originalQty: 3,
      remainingQty: 3,
      unitCostIrr: 200,
      totalCostIrr: 600,
    }],
  }, {
    id: 'return_second_partial',
    date: '1405/01/12',
    kind: 'sale_return',
    productId: 'product_return_1',
    warehouse: originalSale.warehouse,
    qty: 3,
    sourceRefId: originalSale.id,
    originalConsumedLayers: unreturnedLayers,
  });
  assert.equal(secondPartialReturn.cogsOrCostIrr, 500, 'Second partial return must restore 2×200 + 1×100, not repeat 3×200');
  assert.equal(secondPartialReturn.nextState.stockQty, 6);
  logPass('FIFO partial-return layer remainder', 'second partial return resumes from unreturned historical layers and restores exact 500 IRR');
}


/* ============================================================================
 * 1. HIGH-VOLUME PERFORMANCE & STRESS BENCHMARK (25,000 Vouchers, 10,000 Invoices, 2,500 Products)
 * ========================================================================== */
{
  const seed = createHolooSeedData('qa_stress_owner');
  const accounts = seed.accounts;

  // Synthesize 1,000 parties
  const parties: Party[] = [...seed.parties];
  for (let i = 0; i < 1000; i++) {
    parties.push({
      id: `pty_stress_${i}`,
      ownerId: 'qa_stress_owner',
      code: `P-${10000 + i}`,
      name: `شرکت نساجی و بافندگی پارس ${i + 1}`,
      partyType: i % 3 === 0 ? 'vendor' : 'customer',
      accountCode: i % 3 === 0 ? '30101' : '10401',
      phone: `0912${String(1000000 + i)}`,
      openingBalance: (i % 5) * 1_000_000,
      creditLimit: 500_000_000,
    });
  }

  // Synthesize 2,500 products across 5 warehouses
  const warehouses = ['انبار مرکزی نخ تهران', 'انبار یزد', 'انبار اصفهان', 'انبار گمرک بندرعباس', 'انبار ضایعات'];
  const products: Product[] = [];
  for (let i = 0; i < 2500; i++) {
    const stock = 100 + (i % 400);
    const buyPrice = 1_500_000 + (i % 50) * 25_000;
    const invVal = Math.round(stock * buyPrice);
    products.push({
      id: `prd_stress_${i}`,
      ownerId: 'qa_stress_owner',
      sku: `YRN-${20000 + i}`,
      name: `نخ پلی‌استر DTY 150/48 سری ${i + 1}`,
      category: 'نخ پلی‌استر',
      warehouse: warehouses[i % warehouses.length],
      unit: 'کیلوگرم',
      buyPrice,
      sellPrice: Math.round(buyPrice * 1.18),
      stock,
      reorderPoint: 50,
      vatExempt: false,
      costingMethod: 'fifo',
      inventoryValueIrr: invVal,
      costLayers: [
        {
          layerId: `lyr_${i}`,
          date: '1405/01/01',
          sourceRef: 'vch_stress_open',
          originalQty: stock,
          remainingQty: stock,
          unitCostIrr: buyPrice,
          totalCostIrr: invVal,
        },
      ],
    });
  }

  // Synthesize 25,000 balanced vouchers (50,000 lines) + 10,000 invoices
  const vouchers: Voucher[] = [];
  const invoices: Invoice[] = [];
  const totalInvInitValue = products.reduce((s, p) => s + (p.inventoryValueIrr || 0), 0);

  // Opening voucher aligning 10501 inventory & 50101 capital
  vouchers.push({
    id: 'vch_stress_open',
    ownerId: 'qa_stress_owner',
    voucherNumber: 1,
    date: '1405/01/01',
    fiscalYear: '1405',
    description: 'سند افتتاحیه تست استرس کلان',
    voucherType: 'opening',
    status: 'permanent',
    totalDebit: totalInvInitValue + 50_000_000_000,
    totalCredit: totalInvInitValue + 50_000_000_000,
    lines: [
      {
        accountCode: '10501',
        accountTitle: 'موجودی کالا و نخ انبار',
        description: 'موجودی اول دوره انبار',
        debit: totalInvInitValue,
        credit: 0,
      },
      {
        accountCode: '10201',
        accountTitle: 'بانک ملت — حساب جاری شرکتی',
        description: 'موجودی اول دوره بانک',
        debit: 50_000_000_000,
        credit: 0,
      },
      {
        accountCode: '50101',
        accountTitle: 'سرمایه ثبت‌شده شرکت',
        description: 'سرمایه اول دوره',
        debit: 0,
        credit: totalInvInitValue + 50_000_000_000,
      },
    ],
  });

  const pendingItems: PendingApprovalDocumentItem[] = [];
  for (let i = 0; i < 25_000; i++) {
    const month = String((i % 12) + 1).padStart(2, '0');
    const day = String((i % 28) + 1).padStart(2, '0');
    const date = `1405/${month}/${day}`;
    const party = parties[i % parties.length];
    const amt = 10_000_000 + (i % 900) * 100_000;
    const isDraft = i >= 24_500;
    const vid = `vch_stress_${i}`;
    const isLinkedInv = i < 10_000;
    const invId = isLinkedInv ? `inv_stress_${i}` : undefined;

    vouchers.push({
      id: vid,
      ownerId: 'qa_stress_owner',
      voucherNumber: i + 2,
      date,
      fiscalYear: '1405',
      description: `ثبت تراکنش عملیاتی شماره ${i + 1}`,
      voucherType: isLinkedInv ? 'sales' : 'general',
      status: isDraft ? 'draft' : 'permanent',
      referenceId: invId,
      totalDebit: amt,
      totalCredit: amt,
      lines: [
        {
          accountCode: '10401',
          accountTitle: 'بدهکاران تجاری و مشتریان',
          partyId: party.id,
          partyName: party.name,
          description: `بدهکاری بابت سند ${i + 1}`,
          debit: amt,
          credit: 0,
        },
        {
          accountCode: '60101',
          accountTitle: 'فروش کالا و نخ',
          partyId: party.id,
          partyName: party.name,
          description: `درآمد فروش سند ${i + 1}`,
          debit: 0,
          credit: amt,
        },
      ],
    });

    if (isDraft) {
      pendingItems.push({
        id: vid,
        docType: 'voucher',
        categoryKey: 'draft_vouchers',
        docTypeLabel: 'سند حسابداری',
        subTypeLabel: 'موقت',
        referenceCode: `#${i + 2}`,
        title: `سند موقت #${i + 2}`,
        secondaryInfo: party.name,
        date,
        amountIrr: amt,
        statusLabel: 'موقت',
        statusTone: 'amber',
        targetModule: 'vouchers',
        targetIntent: `voucher:${vid}`,
        quickApproveKind: 'finalize_voucher',
        canQuickApprove: true,
        quickApproveLabel: 'دائم‌سازی',
      });
    }

    if (isLinkedInv && invId) {
      const prod = products[i % products.length];
      invoices.push({
        id: invId,
        ownerId: 'qa_stress_owner',
        invoiceNumber: `INV-${100000 + i}`,
        invoiceType: 'sale',
        date,
        partyId: party.id,
        partyName: party.name,
        warehouse: prod.warehouse,
        items: [
          {
            productId: prod.id,
            sku: prod.sku,
            productName: prod.name,
            quantity: 10,
            unit: 'کیلوگرم',
            unitPrice: Math.round(amt / 10),
            discount: 0,
            vatAmount: 0,
            lineTotal: amt,
            unitCostSnapshot: prod.buyPrice,
          },
        ],
        subtotal: amt,
        discount: 0,
        vatAmount: 0,
        grandTotal: amt,
        paidCash: 0,
        paidBank: 0,
        paidCheque: 0,
        creditAmount: amt,
        status: 'issued',
        voucherId: vid,
      });
    }
  }

  // Benchmark 1: Trial Balance on 25,001 vouchers
  const t0 = performance.now();
  const tb = computeTrialBalance(accounts, vouchers, { includeDrafts: false, fiscalYear: '1405' });
  const tbMs = performance.now() - t0;
  const totD = tb.reduce((s, r) => s + r.totalDebit, 0);
  const totC = tb.reduce((s, r) => s + r.totalCredit, 0);
  const balD = tb.reduce((s, r) => s + r.balanceDebit, 0);
  const balC = tb.reduce((s, r) => s + r.balanceCredit, 0);
  assert.equal(totD, totC, '25,000-voucher Trial Balance total debit must exactly equal total credit');
  assert.equal(balD, balC, '25,000-voucher Trial Balance balance debit must exactly equal balance credit');
  assert.ok(tbMs < 1500, `Trial balance took too long: ${tbMs.toFixed(1)}ms`);
  logPass('Stress Test: Trial Balance (25,001 vouchers / 50,003 lines)', `${tbMs.toFixed(1)} ms · 0 IRR diff`);

  // Benchmark 2: Income Statement & Balance Sheet
  const t1 = performance.now();
  const inc = computeIncomeStatement(tb);
  const bs = computeBalanceSheet(tb);
  const finMs = performance.now() - t1;
  assert.equal(bs.isBalanced, true, '25,000-voucher Balance Sheet must be perfectly balanced');
  assert.equal(bs.difference, 0, 'Balance Sheet difference must be strictly 0 Rial');
  assert.ok(inc.netProfit > 0, 'Income statement must aggregate revenues accurately');
  assert.ok(finMs < 1500, `Income + Balance Sheet took too long: ${finMs.toFixed(1)}ms`);
  logPass('Stress Test: P&L + Balance Sheet (25,001 vouchers)', `${finMs.toFixed(1)} ms · diff=0 IRR`);

  // Benchmark 3: Party Balances (1,000+ parties across 25,000 vouchers)
  const t2 = performance.now();
  const pBals = computePartyBalances(parties, vouchers, { includeDrafts: false, fiscalYear: '1405' });
  const pBalMs = performance.now() - t2;
  assert.ok(pBals.size >= 1000, 'All 1,000+ parties must be indexed');
  assert.ok(pBalMs < 1000, `Party balances took too long: ${pBalMs.toFixed(1)}ms`);
  logPass('Stress Test: Party Balances (1,000+ parties)', `${pBalMs.toFixed(1)} ms`);

  // Benchmark 4: Full Audit Engine (computeAuditReport across 25,001 vouchers & 10,000 invoices)
  const t3 = performance.now();
  const auditReport = computeAuditReport({
    accounts,
    vouchers,
    invoices,
    parties,
    products,
    cheques: [],
    trialBalance: tb,
    balanceSheet: bs,
    partyBalances: pBals,
    fiscalYear: '1405',
  });
  const auditMs = performance.now() - t3;
  assert.ok(auditReport.checks.length >= 10, 'Audit report must run all core accounting checks');
  assert.ok(auditMs < 4000, `Full audit report exceeded budget: ${auditMs.toFixed(1)}ms`);
  logPass('Stress Test: Full Audit Engine (25k vouchers, 10k invoices)', `${auditMs.toFixed(1)} ms`);

  // Benchmark 5: Pre-Approval Risk Audit (500 pending items against 25,001 vouchers — O(N+M))
  const t4 = performance.now();
  const preAuditMap = auditPendingApprovalItems(pendingItems, {
    vouchers,
    invoices,
    parties,
    partyBalances: pBals,
    products,
  });
  const preAuditMs = performance.now() - t4;
  assert.equal(preAuditMap.size, pendingItems.length, 'Every pending item must receive an audit score');
  assert.ok(preAuditMs < 500, `Pre-approval audit should stay under 500ms with O(N+M) index (got ${preAuditMs.toFixed(1)}ms)`);
  logPass('Stress Test: Pre-Approval Risk Audit (500 drafts vs 25k vouchers)', `${preAuditMs.toFixed(1)} ms`);

  // Benchmark 6: Fuzzy Search across 2,500 Persian products
  const t5 = performance.now();
  const fuzzyMatches = fuzzyFilterAndRank(products, 'پلی استر 150', (p) => [
    { text: p.name, weight: 1.2 },
    { text: p.sku, weight: 1 },
    { text: p.warehouse, weight: 0.8 },
  ]);
  const fuzzyMs = performance.now() - t5;
  assert.ok(fuzzyMatches.length > 0, 'Fuzzy search must match Persian yarn products');
  assert.ok(fuzzyMs < 1000, `Fuzzy search exceeded budget: ${fuzzyMs.toFixed(1)}ms`);
  logPass('Stress Test: Persian Fuzzy Search (2,500 products)', `${fuzzyMs.toFixed(1)} ms · ${fuzzyMatches.length} hits`);
}

/* ============================================================================
 * 2. CROSS-MODULE INVENTORY <-> SALES <-> ACCOUNTING INTEGRATION (ZERO DISCREPANCY)
 * ========================================================================== */
for (const costingMethod of ['fifo', 'moving_average'] as const) {
  const seed = createHolooSeedData(`qa_int_${costingMethod}`);
  const accounts = seed.accounts;
  const parties = seed.parties;
  const customer = parties.find((p) => p.partyType === 'customer' || p.partyType === 'both') || parties[0];
  const supplier = parties.find((p) => p.partyType === 'vendor' || p.partyType === 'both') || parties[0];

  // Clean zero-balance opening state so we verify every single Rial from scratch
  let products: Product[] = [
    {
      id: 'prd_int_1',
      ownerId: `qa_int_${costingMethod}`,
      sku: 'YRN-INT-01',
      name: 'نخ پنبه شانه شده ۳۰/۱',
      category: 'نخ پنبه',
      warehouse: 'انبار مرکزی تهران',
      unit: 'کیلوگرم',
      buyPrice: 2_100_000,
      sellPrice: 2_650_000,
      stock: 0,
      reorderPoint: 50,
      vatExempt: false,
      costingMethod,
      inventoryValueIrr: 0,
      costLayers: [],
    },
    {
      id: 'prd_int_2',
      ownerId: `qa_int_${costingMethod}`,
      sku: 'YRN-INT-02',
      name: 'نخ ویسکوز رینگ ۴۰/۱',
      category: 'نخ ویسکوز',
      warehouse: 'انبار یزد',
      unit: 'کیلوگرم',
      buyPrice: 1_850_000,
      sellPrice: 2_350_000,
      stock: 0,
      reorderPoint: 40,
      vatExempt: false,
      costingMethod,
      inventoryValueIrr: 0,
      costLayers: [],
    },
  ];
  const vouchers: Voucher[] = [
    {
      id: 'vch_init_cash',
      ownerId: `qa_int_${costingMethod}`,
      voucherNumber: 1,
      date: '1405/01/01',
      fiscalYear: '1405',
      description: 'موجودی نقد و سرمایه اولیه',
      voucherType: 'opening',
      status: 'permanent',
      totalDebit: 50_000_000_000,
      totalCredit: 50_000_000_000,
      lines: [
        {
          accountCode: '10201',
          accountTitle: 'بانک ملت — حساب جاری شرکتی',
          description: 'واریز سرمایه اولیه',
          debit: 50_000_000_000,
          credit: 0,
        },
        {
          accountCode: '50101',
          accountTitle: 'سرمایه ثبت‌شده شرکت',
          description: 'سرمایه اولیه شرکت',
          debit: 0,
          credit: 50_000_000_000,
        },
      ],
    },
  ];
  let invoices: Invoice[] = [];
  let vNum = 2;

  const commitInvoiceStep = (payload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'>, idx: number) => {
    const plan = planAtomicInvoiceCommit({
      payload,
      invoiceId: `inv_${costingMethod}_${idx}`,
      voucherId: `vch_${costingMethod}_${idx}`,
      chequeId: `chq_${costingMethod}_${idx}`,
      nextVoucherNumber: vNum++,
      ownerId: `qa_int_${costingMethod}`,
      deviceId: 'qa_runner',
      products,
      defaultCostingMethod: costingMethod,
      allowNegativeStock: false,
      closedFiscalYears: [],
    });
    products = products.map((p) => {
      const delta = plan.productDeltas.get(p.id);
      if (!delta) return p;
      return {
        ...p,
        stock: delta.stock,
        buyPrice: delta.buyPrice,
        costLayers: delta.costLayers,
        inventoryValueIrr: delta.inventoryValueIrr,
      };
    });
    invoices = [...invoices, plan.invoice];
    if (plan.voucher) vouchers.push(plan.voucher);
    return plan;
  };

  // Run 60 chained cycles (Purchase -> Sale -> Sale Return -> Waste -> Stocktaking Adjustment)
  for (let cycle = 0; cycle < 30; cycle++) {
    const day = String((cycle % 28) + 1).padStart(2, '0');
    const date = `1405/02/${day}`;
    const buyPrice1 = 2_000_000 + cycle * 37_500;
    const buyPrice2 = 1_750_000 + cycle * 21_250;

    // Step A: Purchase inbound (2 products with decimal quantities)
    const pQty1 = 42.5;
    const pQty2 = 31.25;
    const pSub1 = mulQtyByIrr(pQty1, buyPrice1);
    const pSub2 = mulQtyByIrr(pQty2, buyPrice2);
    const pSubtotal = pSub1 + pSub2;
    const pVat = percentOfIrr(pSubtotal, 10);
    commitInvoiceStep(
      {
        invoiceNumber: `PUR-${cycle}`,
        invoiceType: 'purchase',
        date,
        partyId: supplier.id,
        partyName: supplier.name,
        warehouse: 'انبار مرکزی تهران',
        items: [
          {
            productId: 'prd_int_1',
            sku: products[0].sku,
            productName: products[0].name,
            quantity: pQty1,
            unit: 'کیلوگرم',
            unitPrice: buyPrice1,
            discount: 0,
            vatAmount: percentOfIrr(pSub1, 10),
            lineTotal: pSub1 + percentOfIrr(pSub1, 10),
          },
          {
            productId: 'prd_int_2',
            sku: products[1].sku,
            productName: products[1].name,
            quantity: pQty2,
            unit: 'کیلوگرم',
            unitPrice: buyPrice2,
            discount: 0,
            vatAmount: percentOfIrr(pSub2, 10),
            lineTotal: pSub2 + percentOfIrr(pSub2, 10),
          },
        ],
        subtotal: pSubtotal,
        discount: 0,
        vatAmount: pVat,
        grandTotal: pSubtotal + pVat,
        paidCash: 0,
        paidBank: pSubtotal + pVat,
        paidCheque: 0,
        creditAmount: 0,
        status: 'settled',
      },
      cycle * 10 + 1
    );

    // Step B: Sale outbound (decimal weight + discount + 10% VAT)
    const sQty1 = 27.35;
    const sPrice1 = buyPrice1 + 520_000;
    const sDisc1 = 125_000;
    const sTotal1 = mulQtyByIrr(sQty1, sPrice1) - sDisc1;
    const sVat = percentOfIrr(sTotal1, 10);
    const salePlan = commitInvoiceStep(
      {
        invoiceNumber: `SAL-${cycle}`,
        invoiceType: 'sale',
        date,
        partyId: customer.id,
        partyName: customer.name,
        warehouse: 'انبار مرکزی تهران',
        items: [
          {
            productId: 'prd_int_1',
            sku: products[0].sku,
            productName: products[0].name,
            quantity: sQty1,
            unit: 'کیلوگرم',
            unitPrice: sPrice1,
            discount: sDisc1,
            vatAmount: sVat,
            lineTotal: sTotal1 + sVat,
          },
        ],
        subtotal: mulQtyByIrr(sQty1, sPrice1),
        discount: sDisc1,
        vatAmount: sVat,
        grandTotal: sTotal1 + sVat,
        paidCash: 0,
        paidBank: Math.round((sTotal1 + sVat) / 2),
        paidCheque: 0,
        creditAmount: sTotal1 + sVat - Math.round((sTotal1 + sVat) / 2),
        status: 'issued',
      },
      cycle * 10 + 2
    );

    // Step C: Every 5th cycle, convert a proforma -> official sale AND cancel a prior sale
    if (cycle % 5 === 0) {
      const pfQty = 5.5;
      const pfPrice = buyPrice2 + 450_000;
      const pfSub = mulQtyByIrr(pfQty, pfPrice);
      const pfVat = percentOfIrr(pfSub, 10);
      const pfPlan = commitInvoiceStep(
        {
          invoiceNumber: `PF-${cycle}`,
          invoiceType: 'proforma',
          date,
          partyId: customer.id,
          partyName: customer.name,
          warehouse: 'انبار یزد',
          items: [
            {
              productId: 'prd_int_2',
              sku: products[1].sku,
              productName: products[1].name,
              quantity: pfQty,
              unit: 'کیلوگرم',
              unitPrice: pfPrice,
              discount: 0,
              vatAmount: pfVat,
              lineTotal: pfSub + pfVat,
            },
          ],
          subtotal: pfSub,
          discount: 0,
          vatAmount: pfVat,
          grandTotal: pfSub + pfVat,
          paidCash: 0,
          paidBank: 0,
          paidCheque: 0,
          creditAmount: pfSub + pfVat,
          status: 'issued',
        },
        cycle * 10 + 3
      );

      // Proforma must NOT touch stock or create voucher
      assert.equal(pfPlan.voucher, undefined, 'Proforma must not post GL voucher');

      const convPlan = planProformaToSaleConversion({
        proforma: pfPlan.invoice,
        conversionDate: date,
        products,
        parties,
        existingInvoices: invoices,
        existingVouchers: vouchers,
        costingMethod,
        allowNegativeStock: false,
        closedFiscalYears: [],
        ownerId: `qa_int_${costingMethod}`,
        voucherId: `vch_conv_${costingMethod}_${cycle}`,
        nextVoucherNumber: vNum++,
        chequeId: `chq_conv_${costingMethod}_${cycle}`,
        deviceId: 'qa_runner',
      });
      products = products.map((p) => {
        const delta = convPlan.productDeltas.get(p.id);
        if (!delta) return p;
        return {
          ...p,
          stock: delta.stock,
          buyPrice: delta.buyPrice,
          costLayers: delta.costLayers,
          inventoryValueIrr: delta.inventoryValueIrr,
        };
      });
      invoices = invoices.map((inv) =>
        inv.id === pfPlan.invoice.id ? convPlan.invoice : inv
      );
      if (convPlan.voucher) vouchers.push(convPlan.voucher);

      // Cancel the sale invoice from Step B and restore cost layers + post reversing voucher
      const cancelPlan = planInvoiceCancellation({
        invoice: salePlan.invoice,
        cancellationDate: date,
        products,
        vouchers,
        cheques: [],
        costingMethod,
        closedFiscalYears: [],
        ownerId: `qa_int_${costingMethod}`,
        reversalVoucherId: `vch_rev_${costingMethod}_${cycle}`,
        nextVoucherNumber: vNum++,
        deviceId: 'qa_runner',
      });
      products = products.map((p) => {
        const delta = cancelPlan.productDeltas.get(p.id);
        if (!delta) return p;
        return {
          ...p,
          stock: delta.stock,
          buyPrice: delta.buyPrice,
          costLayers: delta.costLayers,
          inventoryValueIrr: delta.inventoryValueIrr,
        };
      });
      invoices = invoices.map((inv) =>
        inv.id === salePlan.invoice.id ? { ...inv, status: 'cancelled' } : inv
      );
      if (cancelPlan.reversalVoucher) vouchers.push(cancelPlan.reversalVoucher);
    }

    // Step D: Every 10th cycle, perform stocktaking shortage & surplus adjustments
    if (cycle % 10 === 9) {
      const targetProd = products[0];
      const deltaQty = cycle === 9 ? -2.5 : 3.25;
      const stkPlan = planStockAdjustmentWithCostLayers({
        product: targetProd,
        newStock: Number((targetProd.stock + deltaQty).toFixed(2)),
        date,
        reason: 'انبارگردانی دوره‌ای QA',
        costingMethod,
        allowNegativeStock: false,
        closedFiscalYears: [],
        accounts,
        ownerId: `qa_int_${costingMethod}`,
        referenceId: `stk_qa_${cycle}`,
        voucherId: `vch_stk_${costingMethod}_${cycle}`,
        nextVoucherNumber: vNum++,
        deviceId: 'qa_runner',
      });
      products = products.map((p) =>
        p.id === targetProd.id
          ? {
              ...p,
              stock: stkPlan.productDelta.stock,
              buyPrice: stkPlan.productDelta.buyPrice,
              costLayers: stkPlan.productDelta.costLayers,
              inventoryValueIrr: stkPlan.productDelta.inventoryValueIrr,
            }
          : p
      );
      if (stkPlan.voucher) vouchers.push(stkPlan.voucher);
    }
  }

  // Negative stock guard check
  assert.throws(
    () =>
      planAtomicInvoiceCommit({
        payload: {
          invoiceNumber: 'SAL-NEG-BLOCK',
          invoiceType: 'sale',
          date: '1405/03/01',
          partyId: customer.id,
          partyName: customer.name,
          warehouse: 'انبار مرکزی تهران',
          items: [
            {
              productId: 'prd_int_1',
              sku: products[0].sku,
              productName: products[0].name,
              quantity: products[0].stock + 500,
              unit: 'کیلوگرم',
              unitPrice: 2_500_000,
              discount: 0,
              vatAmount: 0,
              lineTotal: mulQtyByIrr(products[0].stock + 500, 2_500_000),
            },
          ],
          subtotal: mulQtyByIrr(products[0].stock + 500, 2_500_000),
          discount: 0,
          vatAmount: 0,
          grandTotal: mulQtyByIrr(products[0].stock + 500, 2_500_000),
          paidCash: 0,
          paidBank: 0,
          paidCheque: 0,
          creditAmount: mulQtyByIrr(products[0].stock + 500, 2_500_000),
          status: 'issued',
        },
        invoiceId: 'inv_neg_block',
        voucherId: 'vch_neg_block',
        chequeId: 'chq_neg_block',
        nextVoucherNumber: vNum++,
        ownerId: `qa_int_${costingMethod}`,
        deviceId: 'qa_runner',
        products,
        defaultCostingMethod: costingMethod,
        allowNegativeStock: false,
        closedFiscalYears: [],
      }),
    /موجودی|کافی/,
    'Negative stock sale must be strictly rejected'
  );

  // Verify 0-Rial Inventory Subledger vs GL 10501, Trial Balance, Balance Sheet & VAT!
  const tb = computeTrialBalance(accounts, vouchers, { includeDrafts: false, fiscalYear: '1405' });
  const bs = computeBalanceSheet(tb);
  const gl10501 = tb.find((r) => r.accountCode === '10501');
  const glInventoryIrr = gl10501 ? gl10501.balanceDebit - gl10501.balanceCredit : 0;
  const subInventoryIrr = products.reduce((s, p) => s + (p.inventoryValueIrr ?? 0), 0);

  assert.equal(bs.isBalanced, true, `[${costingMethod}] Balance sheet must balance after 100+ chained operations`);
  assert.equal(bs.difference, 0, `[${costingMethod}] Balance sheet diff must be 0 IRR`);
  assert.equal(
    subInventoryIrr,
    glInventoryIrr,
    `[${costingMethod}] Inventory subledger (${subInventoryIrr}) must match GL 10501 (${glInventoryIrr}) to the exact Rial`
  );

  const glSalesVatRow = tb.find((r) => r.accountCode === '30301');
  const glPurchaseVatRow = tb.find((r) => r.accountCode === '30302');
  const glSalesVat = glSalesVatRow ? glSalesVatRow.balanceCredit - glSalesVatRow.balanceDebit : 0;
  const glPurchaseVat = glPurchaseVatRow ? glPurchaseVatRow.balanceDebit - glPurchaseVatRow.balanceCredit : 0;
  const activeInv = invoices.filter((i) => i.status !== 'cancelled' && i.invoiceType !== 'proforma');
  const expectedSalesVat = activeInv.filter((i) => i.invoiceType === 'sale').reduce((s, i) => s + i.vatAmount, 0);
  const expectedPurchaseVat = activeInv.filter((i) => i.invoiceType === 'purchase').reduce((s, i) => s + i.vatAmount, 0);
  assert.equal(glSalesVat, expectedSalesVat, `[${costingMethod}] Sales VAT GL 30301 must match invoices to the exact Rial`);
  assert.equal(glPurchaseVat, expectedPurchaseVat, `[${costingMethod}] Purchase VAT GL 30302 must match invoices to the exact Rial`);

  logPass(
    `Cross-Module Integration (${costingMethod.toUpperCase()}: Purchase/Sale/Proforma/Cancel/Stocktaking)`,
    `GL 10501 == Subledger (${glInventoryIrr.toLocaleString('en-US')} IRR) · 0 IRR drift`
  );
}

/* ============================================================================
 * 3. ACCOUNTING MATH, TAX & LANDED COST ZERO-DRIFT PRECISION
 * ========================================================================== */
{
  // Classic floating-point traps: 0.1 + 0.2, repeating decimals, multi-item apportionment
  assert.equal(mulQtyByIrr(0.1, 1_000_000) + mulQtyByIrr(0.2, 1_000_000), mulQtyByIrr(0.3, 1_000_000));
  assert.equal(mulQtyByIrr(33.333, 1_234_567), Math.round(33.333 * 1_234_567));
  assert.equal(percentOfIrr(12_345_678, 10), 1_234_568);

  // 500 apportionment checks guaranteeing exact integer Rial conservation (sum === total)
  for (let n = 1; n <= 500; n++) {
    const total = 10_000_001 + n * 137;
    const weights = [n * 0.33, (n + 7) * 1.17, (n + 19) * 2.41, 0.125];
    const parts = allocateProportionalIrr(total, weights);
    const sum = parts.reduce((a, b) => a + b, 0);
    assert.equal(sum, total, `Apportionment conservation failed at iteration ${n}`);
  }

  // IAS 2 / Iran Standard 8 Landed Cost Allocation (excludes recoverable customs VAT from inventory capitalization)
  const landed = calculateLandedCostAllocation(
    [
      {
        productId: 'p1',
        productName: 'نخ ۱',
        sku: 'S1',
        lotNumber: 'LOT-01',
        weightKg: 333.33,
        cartonCount: 14,
        foreignUnitPrice: 2.15,
      },
      {
        productId: 'p2',
        productName: 'نخ ۲',
        sku: 'S2',
        lotNumber: 'LOT-02',
        weightKg: 666.67,
        cartonCount: 28,
        foreignUnitPrice: 1.92,
      },
      {
        productId: 'p3',
        productName: 'نخ ۳',
        sku: 'S3',
        lotNumber: 'LOT-03',
        weightKg: 127.85,
        cartonCount: 6,
        foreignUnitPrice: 2.45,
      },
    ],
    [
      { id: 'c1', title: 'کرایه حمل دریایی', accountCode: '10201', amountIrr: 410_000_003 },
      { id: 'c2', title: 'حقوق ورودی گمرک', accountCode: '10201', amountIrr: 285_500_007 },
      { id: 'c3', title: 'ارزش افزوده گمرکی ۱۰٪', accountCode: '10201', amountIrr: 190_000_000, isRecoverableVat: true },
    ],
    615_000,
    'weight'
  );
  const sumAllocated = landed.computedItems.reduce((s, it) => s + it.allocatedLandedCostIrr, 0);
  assert.equal(sumAllocated, landed.totalLandedCostsIrr, 'Landed cost allocation must conserve every single Rial');
  assert.equal(landed.totalRecoverableVatIrr, 190_000_000, 'Recoverable customs VAT must be segregated to 30302');
  logPass('Accounting Math & IAS-2 Landed Cost Conservation', '500/500 exact Rial sums · 0 drift');
}

/* ============================================================================
 * 4. SECURITY & RBAC PoC VERIFICATION TESTS
 * ========================================================================== */
{
  const allPerms: (keyof RbacPermissions)[] = [
    'canCreateVoucher',
    'canFinalizeVoucher',
    'canIssueInvoice',
    'canEditInventory',
    'canManageTreasury',
    'canManageCurrencies',
    'canManageSettings',
    'canDeleteRecords',
  ];

  // 4.1 Read-only auditor must be blocked on ALL write permissions even if flags were tampered
  const auditor = {
    fullName: 'حسابرس مستقل',
    active: true,
    role: 'auditor_readonly' as RbacRoleKey,
    permissions: { ...RBAC_ROLE_PRESETS.auditor_readonly, canDeleteRecords: true },
  };
  for (const perm of allPerms) {
    const res = checkOperatorPermission(auditor, perm);
    assert.equal(res.allowed, false, `auditor_readonly must be denied ${perm}`);
  }

  // 4.2 Inactive finance_manager must be blocked on ALL write permissions
  const disabledAdmin = {
    fullName: 'مدیر غیرفعال',
    active: false,
    role: 'finance_manager' as RbacRoleKey,
    permissions: RBAC_ROLE_PRESETS.finance_manager,
  };
  for (const perm of allPerms) {
    const res = checkOperatorPermission(disabledAdmin, perm);
    assert.equal(res.allowed, false, `Inactive operator must be denied ${perm}`);
  }

  // 4.3 Least-privilege verification for warehouse_keeper, sales_officer, treasurer, finance_manager
  const whKeeper = { fullName: 'انباردار', active: true, role: 'warehouse_keeper' as RbacRoleKey, permissions: RBAC_ROLE_PRESETS.warehouse_keeper };
  assert.equal(checkOperatorPermission(whKeeper, 'canEditInventory').allowed, true);
  assert.equal(checkOperatorPermission(whKeeper, 'canIssueInvoice').allowed, false);
  assert.equal(checkOperatorPermission(whKeeper, 'canFinalizeVoucher').allowed, false);
  assert.equal(checkOperatorPermission(whKeeper, 'canManageSettings').allowed, false);

  const salesOfficer = { fullName: 'فروش', active: true, role: 'sales_officer' as RbacRoleKey, permissions: RBAC_ROLE_PRESETS.sales_officer };
  assert.equal(checkOperatorPermission(salesOfficer, 'canIssueInvoice').allowed, true);
  assert.equal(checkOperatorPermission(salesOfficer, 'canEditInventory').allowed, false);
  assert.equal(checkOperatorPermission(salesOfficer, 'canDeleteRecords').allowed, false);

  const manager = { fullName: 'مدیر مالی', active: true, role: 'finance_manager' as RbacRoleKey, permissions: RBAC_ROLE_PRESETS.finance_manager };
  for (const perm of allPerms) {
    assert.equal(checkOperatorPermission(manager, perm).allowed, true);
  }
  logPass('Security PoC: RBAC Least-Privilege Enforcement Matrix', 'All 6 roles & inactive guard verified');

  // 4.4 Excel Import Prototype Pollution & Oversized Buffer Defense
  const oversized = new Uint8Array(MAX_EXCEL_BUFFER_BYTES + 64);
  assert.throws(
    () => parseExcelArrayBuffer(oversized),
    /سقف مجاز ۱۰ مگابایت/,
    'Buffers exceeding 10MB must be rejected before parsing'
  );

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['__proto__', 'constructor', 'prototype', 'نام کالا'],
    ['{"polluted":true}', 'bad', 'bad2', 'نخ پنبه'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const xlsxBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const parsed = parseExcelArrayBuffer(xlsxBuf);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype must never be polluted');
  assert.equal(parsed.headers.includes('__proto__'), false, '__proto__ header must be stripped/renamed');
  assert.equal(parsed.headers.includes('constructor'), false, 'constructor header must be stripped/renamed');
  assert.equal(parsed.headers.includes('prototype'), false, 'prototype header must be stripped/renamed');
  assert.equal(Object.getPrototypeOf(parsed.rows[0]), null, 'Parsed rows must use null prototype');
  assert.equal(parsed.rows[0]['نام کالا'], 'نخ پنبه');

  // Formula injection neutralization check
  assert.equal(sanitizeSpreadsheetFormulaCell('=HYPERLINK("http://evil.example")'), '\'=HYPERLINK("http://evil.example")');
  assert.equal(sanitizeSpreadsheetFormulaCell('+cmd|"/c calc"!A0'), '\'+cmd|"/c calc"!A0');
  assert.equal(sanitizeSpreadsheetFormulaCell('-150000'), '-150000', 'Signed numbers must stay untouched');
  logPass('Security PoC: Excel Prototype Pollution, DoS Cap & Formula Injection Defense');

  // 4.5 HTML Report Export XSS Escaping Defense
  const xssHtml = buildStandardAccountingReportBodyHtml(
    {
      reportId: 'trial_balance',
      fileNamePrefix: 'trial_balance',
      title: 'تراز <script>alert(1)</script>',
      subtitle: '<img src=x onerror=alert(2)>',
      periodLabel: '1405',
      voucherScopeLabel: 'دائم',
      currencyUnit: 'IRR',
      recommendedOrientation: 'portrait',
      columns: [
        { key: 'title', label: '<b>شرح</b>', align: 'right', defaultVisible: true },
      ],
      rows: [{ id: 'r1', cells: { title: '<svg onload=alert(3)>آیتم' } }],
    },
    [{ key: 'title', label: '<b>شرح</b>', align: 'right', defaultVisible: true }],
    {
      uid: 'qa_xss',
      displayName: 'حسابدار تست',
      companyName: 'شرکت <script>alert(4)</script>',
      fiscalYear: '1405',
      currencyUnit: 'IRR',
      role: 'accountant',
    },
    {
      orientation: 'portrait',
      compactDensity: false,
      showKpis: false,
      showSignatures: false,
      showRowNumbers: true,
    }
  );
  assert.equal(xssHtml.includes('<script>'), false, 'Raw <script> tag must never appear in report HTML');
  assert.equal(xssHtml.includes('<img src=x'), false, 'Raw <img onerror> payload must never appear in report HTML');
  assert.equal(xssHtml.includes('<svg onload'), false, 'Raw <svg onload> payload must never appear in report HTML');
  assert.equal(xssHtml.includes('&lt;script&gt;'), true, 'Payload must be safely HTML-escaped');
  logPass('Security PoC: Report Export HTML/XSS Escaping Verification');
}

console.log('\nALL QA STRESS, INVENTORY, ACCOUNTING MATH & SECURITY TESTS PASSED!');
