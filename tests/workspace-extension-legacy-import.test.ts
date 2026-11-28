import assert from 'node:assert/strict';
import {
  readLegacyAggregateField, readLegacyJson, readWorkspaceExtensionLegacySources,
  type LegacyStorageReader,
} from '../src/lib/workspaceExtensionLegacyImport';

class MemoryStorage implements LegacyStorageReader {
  constructor(private readonly values: Record<string, string> = {}) {}
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
  }
}
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    !Object.keys(value).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)));

assert.deepEqual(readLegacyJson(new MemoryStorage(), 'missing', isArray), { status: 'absent' });
assert.deepEqual(readLegacyJson(new MemoryStorage({ key: '[]' }), 'key', isArray),
  { status: 'valid', value: [] }, 'explicit empty arrays remain distinct from absent keys');
assert.deepEqual(readLegacyJson(new MemoryStorage({ key: '{broken' }), 'key', isArray),
  { status: 'malformed', reason: 'invalid_json' });
assert.deepEqual(readLegacyJson(new MemoryStorage({ key: '{"items":[]}' }), 'key', isArray),
  { status: 'malformed', reason: 'invalid_shape' });

const denied: LegacyStorageReader = {
  getItem() { throw Object.assign(new Error('do not expose'), { name: 'SecurityError' }); },
};
assert.deepEqual(readLegacyJson(denied, 'key', isArray),
  { status: 'inaccessible', errorName: 'SecurityError' });

const keys = {
  aggregate: 'aggregate', reservedInvoices: 'reserved',
  favoriteMenus: 'favorites', productMetaMap: 'productMeta',
};
const sources = readWorkspaceExtensionLegacySources(new MemoryStorage({
  aggregate: JSON.stringify({ reservedInvoices: [], favoriteMenus: ['sales'], productMetaMap: {} }),
  reserved: '[{"id":"r1"}]', favorites: '[]', productMeta: '{"sku-1":{"color":"blue"}}',
}), keys);
assert.equal(sources.aggregate.status, 'valid');
assert.deepEqual(sources.reservedInvoices, { status: 'valid', value: [{ id: 'r1' }] });
assert.deepEqual(sources.favoriteMenus, { status: 'valid', value: [] });
assert.deepEqual(sources.productMetaMap, { status: 'valid', value: { 'sku-1': { color: 'blue' } } });

if (sources.aggregate.status === 'valid') {
  assert.deepEqual(readLegacyAggregateField(sources.aggregate, 'reservedInvoices', isArray),
    { status: 'valid', value: [] }, 'valid empty aggregate values remain authoritative inputs');
  assert.deepEqual(readLegacyAggregateField(sources.aggregate, 'favoriteMenus', isArray),
    { status: 'valid', value: ['sales'] });
  assert.deepEqual(readLegacyAggregateField(sources.aggregate, 'missingField', isArray),
    { status: 'absent' });
  assert.deepEqual(readLegacyAggregateField(sources.aggregate, 'productMetaMap', isArray),
    { status: 'malformed', reason: 'invalid_shape' });
}

const malformedAggregate = readWorkspaceExtensionLegacySources(new MemoryStorage({
  aggregate: '{invalid', reserved: '[]', favorites: '["sales"]', productMeta: '{}',
}), keys);
assert.deepEqual(malformedAggregate.aggregate, { status: 'malformed', reason: 'invalid_json' });
assert.deepEqual(malformedAggregate.reservedInvoices, { status: 'valid', value: [] },
  'a malformed aggregate does not suppress independent mirror reads');

const partlyDenied = readWorkspaceExtensionLegacySources({
  getItem(key) { if (key === 'aggregate') throw new Error('denied'); return null; },
}, keys);
assert.deepEqual(partlyDenied.aggregate, { status: 'inaccessible', errorName: 'Error' });
assert.deepEqual(partlyDenied.favoriteMenus, { status: 'absent' },
  'one inaccessible key does not suppress reads of other keys');

assert.deepEqual(readLegacyJson(
  new MemoryStorage({ key: '{"__proto__":{"polluted":true}}' }), 'key', isRecord
), { status: 'malformed', reason: 'invalid_shape' });

console.log('Workspace extension legacy source classification tests passed');
