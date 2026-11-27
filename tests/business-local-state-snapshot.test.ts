import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const values = new Map<string, string>([
  ['holoo_apex96_workspace_extensions_v2', JSON.stringify({
    reservedInvoices: [], productMetaMap: {}, favoriteMenus: ['dashboard'],
    pettyCashCeilingIrr: 100, pettyCashItems: [], recurringTemplates: [],
    bankLoans: [], dyeLots: [], warehouseSlips: [], bomFormulas: [],
    installmentPlans: [], volumeDiscountRules: [], moadianLinks: {}, fiscalArchives: [],
  })],
  ['holoo_apex_voucher_templates_v1', JSON.stringify([{
    id: 'custom-1', name: 'Custom', lines: [{ accountCode: '101' }],
  }])],
  ['holoo_apex_bank_recon_sessions_v1', JSON.stringify({
    '10201': { row1: { statementRowId: 'row1', reviewStatus: 'confirmed' } },
  })],
  ['holoo_apex_warehouse_transfers_v1', JSON.stringify([{
    id: 'transfer-1', productId: 'product-1', fromWarehouse: 'A',
    toWarehouse: 'B', qty: 4, status: 'in_transit',
  }])],
  ['holoo_apex_invoice_settings_v1', JSON.stringify({ template: 'modern_textile' })],
  ['holoo_apex_sync_conflict_default_v1', 'ask'],
  ['holoo_apex_conflict_policy_v1', 'last_write_wins'],
  ['holoo_apex_supabase_revision_v1', '12'],
]);
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, String(value)); },
  removeItem: (key: string) => { values.delete(key); },
  clear: () => values.clear(),
};
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: storage, crypto: webcrypto },
});

const {
  captureBusinessLocalStateSnapshot,
  restoreBusinessLocalStateSnapshot,
  validateBusinessLocalStateSnapshot,
  countBusinessLocalStateSnapshotRecords,
} = await import('../src/lib/businessLocalStateSnapshot');

const snapshot = captureBusinessLocalStateSnapshot();
assert.equal(snapshot.schemaVersion, 1);
assert.ok(countBusinessLocalStateSnapshotRecords(snapshot) > 8);
const expectedTemplates = snapshot.stores.holoo_apex_voucher_templates_v1;
const expectedTransfers = snapshot.stores.holoo_apex_warehouse_transfers_v1;
values.set('holoo_apex_voucher_templates_v1', '[]');
values.set('holoo_apex_warehouse_transfers_v1', '[]');
values.set('holoo_apex_sync_conflict_default_v1', 'keep_local');
restoreBusinessLocalStateSnapshot(snapshot);
assert.equal(values.get('holoo_apex_voucher_templates_v1'), expectedTemplates);
assert.equal(values.get('holoo_apex_warehouse_transfers_v1'), expectedTransfers);
assert.equal(values.get('holoo_apex_sync_conflict_default_v1'), 'ask');
assert.equal(values.get('holoo_apex_supabase_revision_v1'), '12');

// A malformed item anywhere in the package is rejected before any local key changes.
const before = new Map(values);
const malformed = {
  ...snapshot,
  stores: {
    ...snapshot.stores,
    holoo_apex_warehouse_transfers_v1: JSON.stringify([{
      id: 'bad-transfer', productId: 'p1', fromWarehouse: 'A',
      toWarehouse: 'B', qty: Number.NaN, status: 'in_transit',
    }]),
  },
};
assert.throws(() => validateBusinessLocalStateSnapshot(malformed));
assert.deepEqual(values, before);

// Numeric sync cursors must remain decimal integer strings; malformed metadata is rejected.
assert.throws(() => validateBusinessLocalStateSnapshot({
  ...snapshot,
  stores: { ...snapshot.stores, holoo_apex_supabase_revision_v1: '12x' },
}));
assert.throws(() => validateBusinessLocalStateSnapshot({
  ...snapshot,
  stores: { ...snapshot.stores, holoo_apex_supabase_revision_v1: '1.5' },
}));

// A quota/write failure may interrupt localStorage replay. Re-running the same
// validated snapshot must replace the allowlist and converge to the same state.
const originalSetItem = storage.setItem;
let writeCount = 0;
storage.setItem = (key: string, value: string) => {
  writeCount += 1;
  if (writeCount === 2) throw new Error('simulated localStorage quota failure');
  originalSetItem(key, value);
};
assert.throws(() => restoreBusinessLocalStateSnapshot(snapshot));
storage.setItem = originalSetItem;
restoreBusinessLocalStateSnapshot(snapshot);
assert.equal(values.get('holoo_apex_voucher_templates_v1'), expectedTemplates);
assert.equal(values.get('holoo_apex_warehouse_transfers_v1'), expectedTransfers);
assert.equal(values.get('holoo_apex_supabase_revision_v1'), '12');

// Unknown keys are rejected so credentials/device secrets cannot be smuggled into the snapshot.
assert.throws(() => validateBusinessLocalStateSnapshot({
  ...snapshot,
  stores: { ...snapshot.stores, holoo_apex_device_pin_hash: 'secret' },
}));
console.log('PASS: allowlisted business local-state snapshot validation, restore, and replacement');
