import assert from 'node:assert/strict';
import { createHolooSeedData } from '../src/data/holooSeed';
import { validateVoucherPayload } from '../src/lib/accountingEngine';
import { applyInventoryMovementStep, recalculateInventoryLedger } from '../src/lib/inventoryCostingEngine';
import type { ProductInventoryState } from '../src/lib/inventoryCostingEngine';

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

console.log('Phase 1 targeted regression tests: 4 passed, 0 failed');
