/**
 * Read-only parser for the four legacy workspace-extension storage inputs.
 * It preserves absent, malformed, and inaccessible as distinct states. It does
 * not open IndexedDB, mutate storage, or decide migration precedence.
 */
export type LegacyStorageRead<T> =
  | { status: 'absent' }
  | { status: 'inaccessible'; errorName: string }
  | { status: 'malformed'; reason: 'invalid_json' | 'invalid_shape' }
  | { status: 'valid'; value: T };

export interface LegacyStorageReader { getItem(key: string): string | null; }
export interface WorkspaceExtensionLegacyKeys {
  aggregate: string;
  reservedInvoices: string;
  favoriteMenus: string;
  productMetaMap: string;
}
export interface WorkspaceExtensionLegacySources {
  aggregate: LegacyStorageRead<Record<string, unknown>>;
  reservedInvoices: LegacyStorageRead<unknown[]>;
  favoriteMenus: LegacyStorageRead<unknown[]>;
  productMetaMap: LegacyStorageRead<Record<string, unknown>>;
}

function isSafeRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return !Object.keys(value).some((key) =>
    key === '__proto__' || key === 'constructor' || key === 'prototype'
  );
}
function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error &&
      typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name.slice(0, 80);
  }
  return 'UnknownStorageError';
}

/** Read one JSON key without collapsing missing, invalid, or denied storage access. */
export function readLegacyJson<T>(
  storage: LegacyStorageReader,
  key: string,
  validate: (value: unknown) => value is T
): LegacyStorageRead<T> {
  let raw: string | null;
  try { raw = storage.getItem(key); }
  catch (error) { return { status: 'inaccessible', errorName: errorName(error) }; }
  if (raw === null) return { status: 'absent' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { status: 'malformed', reason: 'invalid_json' }; }
  try {
    return validate(parsed)
      ? { status: 'valid', value: parsed }
      : { status: 'malformed', reason: 'invalid_shape' };
  } catch {
    return { status: 'malformed', reason: 'invalid_shape' };
  }
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isRecord = (value: unknown): value is Record<string, unknown> => isSafeRecord(value);

/** Reads only the four documented business-extension keys. */
export function readWorkspaceExtensionLegacySources(
  storage: LegacyStorageReader,
  keys: WorkspaceExtensionLegacyKeys
): WorkspaceExtensionLegacySources {
  return {
    aggregate: readLegacyJson(storage, keys.aggregate, isRecord),
    reservedInvoices: readLegacyJson(storage, keys.reservedInvoices, isArray),
    favoriteMenus: readLegacyJson(storage, keys.favoriteMenus, isArray),
    productMetaMap: readLegacyJson(storage, keys.productMetaMap, isRecord),
  };
}

/** Extract an aggregate field while retaining absent vs malformed information. */
export function readLegacyAggregateField<T>(
  aggregate: LegacyStorageRead<Record<string, unknown>>,
  field: string,
  validate: (value: unknown) => value is T
): LegacyStorageRead<T> {
  if (aggregate.status === 'absent') return { status: 'absent' };
  if (aggregate.status === 'inaccessible' || aggregate.status === 'malformed') return aggregate;
  if (!Object.prototype.hasOwnProperty.call(aggregate.value, field)) return { status: 'absent' };
  try {
    const value = aggregate.value[field];
    return validate(value)
      ? { status: 'valid', value }
      : { status: 'malformed', reason: 'invalid_shape' };
  } catch {
    return { status: 'malformed', reason: 'invalid_shape' };
  }
}
