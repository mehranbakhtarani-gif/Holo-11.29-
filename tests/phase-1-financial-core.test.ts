import assert from 'node:assert/strict';
import { createHolooSeedData } from '../src/data/holooSeed';
import { calculateMonthlyDepreciation, validateVoucherPayload } from '../src/lib/accountingEngine';
import { applyInventoryMovementStep, recalculateInventoryLedger } from '../src/lib/inventoryCostingEngine';
import type { ProductInventoryState } from '../src/lib/inventoryCostingEngine';
import type { Voucher } from '../src/types/accounting';

const fifoState: ProductInventoryState = {
  productId: 'prd_phase1',
  costingMethod: 'fifo',
  stockQty: 10,
  totalValueIrr: 1_000,
  weightedAvgUnitCostIrr: 100,
  layers: [{
    layerId: 'purchase-layer-1',
    date: '1405/01/01',
    sourceRef: 'purchase-1',
    warehouse: 'main',
    originalQty: 10,
    remainingQty: 10,
    unitCostIrr: 100,
    totalCostIrr: 1_000,
  }],
};

assert.throws(
  () => applyInventoryMovementStep(fifoState, {
    id: 'return-too-large',
    date: '1405/01/02',
    kind: 'sale_return',
    productId: 'prd_phase1',
    qty: 11,
    sourceRefId: 'sale-1',
    originalConsumedLayers: [{ layerId: 'sold-layer', qty: 10, unitCostIrr: 100, totalCostIrr: 1_000 }],
  }),
  /از مقدار فروش مرجع/
);

assert.throws(
  () => applyInventoryMovementStep(fifoState, {
    id: 'purchase-return-wrong-source',
    date: '1405/01/03',
    kind: 'purchase_return',
    productId: 'prd_phase1',
    qty: 2,
    totalCostIrr: 200,
    sourceRefId: 'purchase-missing',
  }),
  /لایه خرید مرجع پیدا نشد|لایه مرجع پیدا نشد/
);

assert.throws(
  () => recalculateInventoryLedger({
    productId: 'prd_phase1',
    costingMethod: 'periodic_average',
    movements: [
      { id: 'opening', date: '1405/01/01', sequence: 1, kind: 'opening', productId: 'prd_phase1', qty: 5, totalCostIrr: 500 },
      { id: 'invalid-return', date: '1405/01/02', sequence: 2, kind: 'purchase_return', productId: 'prd_phase1', qty: 6, totalCostIrr: 600 },
      { id: 'later-purchase', date: '1405/01/03', sequence: 3, kind: 'purchase', productId: 'prd_phase1', qty: 10, totalCostIrr: 1_000 },
    ],
  }),
  /برای برگشت از خرید کافی نیست/
);

const validAsset = {
  id: 'asset-test',
  ownerId: 'phase1-test',
  assetCode: 'AST-001',
  title: 'Office equipment',
  purchaseDate: '1405/01/01',
  purchaseCost: 1_200_000,
  salvageValue: 0,
  usefulLifeYears: 5,
  accumulatedDepreciation: 0,
};
assert.equal(calculateMonthlyDepreciation(validAsset), 20_000);
assert.throws(
  () => calculateMonthlyDepreciation({ ...validAsset, salvageValue: 1_300_000 }),
  /اطلاعات مالی دارایی/
);
assert.throws(
  () => calculateMonthlyDepreciation({ ...validAsset, accumulatedDepreciation: 1_200_001 }),
  /استهلاک انباشته/
);

const seed = createHolooSeedData('phase1-test');
const unsafeVoucher = validateVoucherPayload({
  payload: {
    date: '1405/01/01',
    description: 'unsafe integer test',
    voucherType: 'general',
    lines: [
      { accountCode: '10101', accountTitle: 'Cash', description: 'debit', debit: Number.MAX_SAFE_INTEGER + 1, credit: 0 },
      { accountCode: '40101', accountTitle: 'Revenue', description: 'credit', debit: 0, credit: Number.MAX_SAFE_INTEGER + 1 },
    ],
  },
  accounts: seed.accounts,
});
assert.equal(unsafeVoucher.valid, false, 'Unsafe integer Rial amounts must be rejected');
assert.ok(unsafeVoucher.errors.some((error) => error.includes('دقت امن')));

const payrollReferenceId = 'payroll:1405:فروردین';
const priorPayrollVoucher: Voucher = {
  id: 'vch_prior_payroll',
  ownerId: 'phase1-test',
  voucherNumber: 7,
  date: '1405/01/31',
  fiscalYear: '1405',
  description: 'Payroll April',
  voucherType: 'payroll',
  status: 'permanent',
  totalDebit: 100,
  totalCredit: 100,
  referenceId: payrollReferenceId,
  lines: [
    { accountCode: '10101', accountTitle: 'Cash', description: 'debit', debit: 100, credit: 0 },
    { accountCode: '40101', accountTitle: 'Revenue', description: 'credit', debit: 0, credit: 100 },
  ],
};
const duplicatePayroll = validateVoucherPayload({
  payload: {
    date: '1405/01/31',
    description: 'Duplicate payroll',
    voucherType: 'payroll',
    referenceId: payrollReferenceId,
    lines: priorPayrollVoucher.lines,
  },
  accounts: seed.accounts,
  existingVouchers: [priorPayrollVoucher],
});
assert.equal(duplicatePayroll.valid, false, 'A payroll period reference must not be posted twice');
assert.ok(duplicatePayroll.errors.some((error) => error.includes('قبلاً سند شماره')));

console.log('Phase 2 financial regression tests: 8 passed, 0 failed');
