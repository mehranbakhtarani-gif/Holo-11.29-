import assert from 'node:assert/strict';
import { mergeRemoteArray } from '../src/lib/workspaceExtensionsMerge';

const fallback = ['local-a', 'local-b'];
assert.deepEqual(mergeRemoteArray([], fallback), [], 'an explicit empty cloud array clears local data');
assert.deepEqual(mergeRemoteArray(['cloud-a'], fallback), ['cloud-a']);
assert.deepEqual(mergeRemoteArray(undefined, fallback), fallback, 'missing cloud field preserves local data');
assert.deepEqual(mergeRemoteArray(null, fallback), fallback, 'null cloud field preserves local data');
console.log('Workspace extension cloud merge tests passed');
