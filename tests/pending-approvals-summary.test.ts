import assert from 'node:assert/strict';
import {
  buildPendingApprovalItems,
  computePendingApprovalsSummary,
  filterPendingApprovalItems,
} from '../src/lib/pendingApprovalsSummary';
import { createHolooSeedData } from '../src/data/holooSeed';
import type { Invoice, Voucher } from '../src/types/accounting';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

test('computePendingApprovalsSummary summarizes seed pending imports and open operations accurately', () => {
  const seed = createHolooSeedData('test-owner');
  const summary = computePendingApprovalsSummary({
    vouchers: seed.vouchers,
    invoices: seed.invoices,
    reservedInvoices: [],
    importDossiers: seed.importDossiers,
    salesOrders: seed.salesOrders,
    subcontractJobs: seed.subcontractJobs,
    warehouseSlips: [],
    pettyCashItems: [],
  });

  assert.equal(summary.draftVouchersCount, 0);
  assert.equal(summary.voucherApprovalRatePct, 100);
  assert.equal(summary.pendingImportsCount, 1);
  assert.equal(summary.importsInCustomsCount, 1);
  assert.equal(summary.pendingOperationsCount, 2);
  assert.equal(summary.totalPendingCount, 3);
  assert.equal(summary.urgencyLevel, 'attention');
  assert.ok(summary.totalPendingValueIrr > 0);
});

test('computePendingApprovalsSummary detects draft vouchers, unbalanced drafts, and pending proformas', () => {
  const seed = createHolooSeedData('test-owner');
  const balancedDraft: Voucher = {
    id: 'vch_draft_1',
    ownerId: 'test-owner',
    voucherNumber: 10,
    date: '1405/06/02',
    description: 'سند هزینه اجاره دفتر',
    voucherType: 'general',
    status: 'draft',
    totalDebit: 500_000_000,
    totalCredit: 500_000_000,
    lines: [],
  };
  const unbalancedDraft: Voucher = {
    id: 'vch_draft_2',
    ownerId: 'test-owner',
    voucherNumber: 11,
    date: '1405/06/05',
    description: 'سند ناقص',
    voucherType: 'treasury',
    status: 'draft',
    totalDebit: 200_000_000,
    totalCredit: 150_000_000,
    lines: [],
  };
  const openProforma: Invoice = {
    ...seed.invoices[0],
    id: 'inv_pf_1',
    invoiceNumber: 'PF-1405-001',
    invoiceType: 'proforma',
    status: 'issued',
    grandTotal: 1_200_000_000,
  };
  const cancelledProforma: Invoice = {
    ...openProforma,
    id: 'inv_pf_cancelled',
    status: 'cancelled',
  };

  const summary = computePendingApprovalsSummary({
    vouchers: [...seed.vouchers, balancedDraft, unbalancedDraft],
    invoices: [...seed.invoices, openProforma, cancelledProforma],
    reservedInvoices: [],
    importDossiers: seed.importDossiers,
    salesOrders: seed.salesOrders,
    subcontractJobs: seed.subcontractJobs,
    warehouseSlips: [],
    pettyCashItems: [],
  });

  assert.equal(summary.draftVouchersCount, 2);
  assert.equal(summary.unbalancedDraftCount, 1);
  assert.equal(summary.oldestDraftDate, '1405/06/02');
  assert.equal(summary.draftVouchersTotalIrr, 700_000_000);
  assert.equal(summary.draftVouchers[0].voucherNumber, 11);
  assert.equal(summary.pendingProformas.length, 1);
  assert.equal(summary.pendingInvoicesTotalIrr, 1_200_000_000);
  assert.equal(summary.urgencyLevel, 'action_required');

  // Verify unified interactive items + document type filtering + quick-approve flags
  const items = buildPendingApprovalItems(summary);
  assert.equal(items.length, 6);

  const vouchersOnly = filterPendingApprovalItems(items, 'voucher', '');
  assert.equal(vouchersOnly.length, 2);
  const balancedItem = vouchersOnly.find((i) => i.id === 'vch_draft_1');
  const unbalancedItem = vouchersOnly.find((i) => i.id === 'vch_draft_2');
  assert.equal(balancedItem?.quickApproveKind, 'finalize_voucher');
  assert.equal(balancedItem?.canQuickApprove, true);
  assert.equal(unbalancedItem?.canQuickApprove, false);

  const invoicesOnly = filterPendingApprovalItems(items, 'invoice', '');
  assert.equal(invoicesOnly.length, 1);
  assert.equal(invoicesOnly[0].quickApproveKind, 'convert_proforma');
  assert.equal(invoicesOnly[0].canQuickApprove, true);

  const importsOnly = filterPendingApprovalItems(items, 'import', '');
  assert.equal(importsOnly.length, 1);
  assert.equal(importsOnly[0].quickApproveKind, 'clear_import');
  assert.equal(importsOnly[0].canQuickApprove, true);

  const opsOnly = filterPendingApprovalItems(items, 'operation', '');
  assert.equal(opsOnly.length, 2);
  const dispatchedOrderItem = opsOnly.find((i) => i.quickApproveKind === 'invoice_sales_order');
  assert.equal(dispatchedOrderItem?.canQuickApprove, true);

  // Persian fuzzy search across unified items
  const searched = filterPendingApprovalItems(items, 'all', 'اجاره دفتر');
  assert.equal(searched.length, 1);
  assert.equal(searched[0].id, 'vch_draft_1');
});

test('computePendingApprovalsSummary reports clear urgency when all queues are empty', () => {
  const summary = computePendingApprovalsSummary({
    vouchers: [],
    invoices: [],
    reservedInvoices: [],
    importDossiers: [],
    salesOrders: [],
    subcontractJobs: [],
    warehouseSlips: [],
    pettyCashItems: [],
  });

  assert.equal(summary.totalPendingCount, 0);
  assert.equal(summary.totalPendingValueIrr, 0);
  assert.equal(summary.voucherApprovalRatePct, 100);
  assert.equal(summary.urgencyLevel, 'clear');
  assert.equal(buildPendingApprovalItems(summary).length, 0);
});

console.log('All pending approvals interactive viewer & summary tests passed.');
