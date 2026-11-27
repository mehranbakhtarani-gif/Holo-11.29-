import assert from 'node:assert/strict';
import {
  getChangedWorkspaceExtensionKeys,
  mergeRemoteArray,
  mergeWorkspaceExtensionField,
} from '../src/lib/workspaceExtensionsMerge';

const fallback = ['local-a', 'local-b'];
assert.deepEqual(mergeRemoteArray([], fallback), [], 'an explicit empty cloud array clears local data');
assert.deepEqual(mergeRemoteArray(['cloud-a'], fallback), ['cloud-a']);
assert.deepEqual(mergeRemoteArray(undefined, fallback), fallback, 'missing cloud field preserves local data');
assert.deepEqual(mergeRemoteArray(null, fallback), fallback, 'null cloud field preserves local data');

const base = {
  favoriteMenus: ['sales'],
  pettyCashCeilingIrr: 100,
  bankLoans: [{ id: 'loan-1', amount: 10 }],
};
const next = {
  ...base,
  favoriteMenus: ['sales', 'inventory'],
};
assert.deepEqual(
  getChangedWorkspaceExtensionKeys(base, next),
  ['favoriteMenus'],
  'only locally changed top-level fields should be sent to the cloud'
);

const concurrentRemote = {
  ...base,
  pettyCashCeilingIrr: 250,
};
const localPatch = Object.fromEntries(
  getChangedWorkspaceExtensionKeys(base, next).map((key) => [key, next[key]])
);
assert.deepEqual(
  { ...concurrentRemote, ...localPatch },
  {
    favoriteMenus: ['sales', 'inventory'],
    pettyCashCeilingIrr: 250,
    bankLoans: [{ id: 'loan-1', amount: 10 }],
  },
  'a local edit must preserve unrelated fields changed by another device'
);

assert.deepEqual(
  getChangedWorkspaceExtensionKeys(base, { ...base }),
  [],
  'unchanged state should not create a cloud write'
);

const disjointArrayMerge = mergeWorkspaceExtensionField(
  [{ id: 'lot-a', qty: 10 }, { id: 'lot-b', qty: 20 }],
  [{ id: 'lot-a', qty: 12 }, { id: 'lot-b', qty: 20 }],
  [{ id: 'lot-a', qty: 10 }, { id: 'lot-b', qty: 25 }]
);
assert.equal(disjointArrayMerge.ok, true);
assert.deepEqual(disjointArrayMerge.value, [
  { id: 'lot-a', qty: 12 },
  { id: 'lot-b', qty: 25 },
], 'independent entity edits from two devices must merge by stable id');

const localDeleteRemoteEdit = mergeWorkspaceExtensionField(
  [{ id: 'loan-a', amount: 10 }, { id: 'loan-b', amount: 20 }],
  [{ id: 'loan-b', amount: 20 }],
  [{ id: 'loan-a', amount: 15 }, { id: 'loan-b', amount: 20 }]
);
assert.equal(localDeleteRemoteEdit.ok, false);
assert.deepEqual(localDeleteRemoteEdit.conflicts, ['loan-a'],
  'a delete must conflict with a concurrent edit instead of silently resurrecting or discarding the record');

const sameEntityConflict = mergeWorkspaceExtensionField(
  [{ id: 'loan-a', amount: 10 }],
  [{ id: 'loan-a', amount: 12 }],
  [{ id: 'loan-a', amount: 14 }]
);
assert.equal(sameEntityConflict.ok, false);
assert.deepEqual(sameEntityConflict.conflicts, ['loan-a']);

const mapMerge = mergeWorkspaceExtensionField(
  { invoiceA: { state: 'pending' } },
  { invoiceA: { state: 'sent' }, invoiceB: { state: 'pending' } },
  { invoiceA: { state: 'pending' }, invoiceC: { state: 'sent' } }
);
assert.equal(mapMerge.ok, true);
assert.deepEqual(mapMerge.value, {
  invoiceA: { state: 'sent' },
  invoiceB: { state: 'pending' },
  invoiceC: { state: 'sent' },
}, 'independent map keys must merge without overwriting each other');

const unkeyedArrayConflict = mergeWorkspaceExtensionField(
  ['sales'],
  ['sales', 'inventory'],
  ['sales', 'purchases']
);
assert.equal(unkeyedArrayConflict.ok, false,
  'concurrent primitive-array edits must surface a conflict rather than blindly unioning and reviving deletions');

const scalarConflict = mergeWorkspaceExtensionField(100, 120, 130);
assert.equal(scalarConflict.ok, false,
  'concurrent edits to the same scalar must be rejected');

const pollutedMap = JSON.parse('{"__proto__":{"polluted":true},"safeKey":{"state":"ok"}}');
const pollutedMerge = mergeWorkspaceExtensionField({}, pollutedMap, {});
assert.equal(pollutedMerge.ok, false,
  'prototype-sensitive map keys must be rejected at the workspace merge boundary');


console.log('Workspace extension merge and concurrent patch tests passed');
