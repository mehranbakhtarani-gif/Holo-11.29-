import assert from 'node:assert/strict';
import {
  getChangedWorkspaceExtensionKeys,
  mergeRemoteArray,
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
console.log('Workspace extension merge and concurrent patch tests passed');
