/** Preserve fallback only when a cloud field is absent or malformed.
 * An explicitly empty array is a valid remote value and must clear local items.
 */
export function mergeRemoteArray<T>(remote: unknown, fallback: readonly T[]): T[] {
  return Array.isArray(remote) ? (remote as T[]) : [...fallback];
}

/** Return only top-level workspace fields changed by a local mutation.
 * Workspace extension values are JSON-serializable Firestore data.
 */
export function getChangedWorkspaceExtensionKeys<T extends object>(
  previous: T,
  next: T
): (keyof T)[] {
  return (Object.keys(next) as (keyof T)[]).filter((key) => {
    const before = previous[key];
    const after = next[key];
    if (Object.is(before, after)) return false;
    try {
      return JSON.stringify(before) !== JSON.stringify(after);
    } catch {
      return true;
    }
  });
}

export interface WorkspaceExtensionMergeResult {
  ok: boolean;
  value?: unknown;
  conflicts: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toIdMap(rows: unknown[]): Map<string, Record<string, unknown>> | null {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id.trim() || result.has(row.id)) {
      return null;
    }
    result.set(row.id, row);
  }
  return result;
}

/**
 * Three-way merge for a single top-level field. Entity arrays merge by stable id,
 * maps merge by key, and scalar/unkeyed arrays fail closed on concurrent edits.
 * Deletes are explicit deltas; no blind union can resurrect a deleted record.
 */
export function mergeWorkspaceExtensionField(
  base: unknown,
  local: unknown,
  remote: unknown
): WorkspaceExtensionMergeResult {
  if (sameValue(remote, base) || sameValue(local, remote)) {
    return { ok: true, value: local, conflicts: [] };
  }
  if (sameValue(local, base)) {
    return { ok: true, value: remote, conflicts: [] };
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const baseMap = toIdMap(base);
    const localMap = toIdMap(local);
    const remoteMap = toIdMap(remote);
    if (!baseMap || !localMap || !remoteMap) {
      return { ok: false, conflicts: ['array-without-stable-unique-ids'] };
    }

    const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
    const merged = new Map<string, Record<string, unknown>>();
    const conflicts: string[] = [];
    for (const id of ids) {
      const before = baseMap.get(id);
      const localValue = localMap.get(id);
      const remoteValue = remoteMap.get(id);
      const localChanged = !sameValue(localValue, before);
      const remoteChanged = !sameValue(remoteValue, before);
      if (localChanged && remoteChanged && !sameValue(localValue, remoteValue)) {
        conflicts.push(id);
        continue;
      }
      const chosen = localChanged ? localValue : remoteValue;
      if (chosen) merged.set(id, chosen);
    }
    if (conflicts.length) return { ok: false, conflicts };

    const orderedIds = [
      ...remote.map((row) => (row as Record<string, unknown>).id as string),
      ...local.map((row) => (row as Record<string, unknown>).id as string),
    ];
    const seen = new Set<string>();
    const value: Record<string, unknown>[] = [];
    for (const id of orderedIds) {
      const row = merged.get(id);
      if (row && !seen.has(id)) {
        value.push(row);
        seen.add(id);
      }
    }
    return { ok: true, value, conflicts: [] };
  }

  if (isRecord(base) && isRecord(local) && isRecord(remote)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    const unsafeKeys = [...keys].filter((key) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype'
    );
    if (unsafeKeys.length) return { ok: false, conflicts: unsafeKeys };
    const value: Record<string, unknown> = {};
    const conflicts: string[] = [];
    for (const key of keys) {
      const before = base[key];
      const localValue = local[key];
      const remoteValue = remote[key];
      const localChanged = !sameValue(localValue, before);
      const remoteChanged = !sameValue(remoteValue, before);
      if (localChanged && remoteChanged && !sameValue(localValue, remoteValue)) {
        conflicts.push(key);
        continue;
      }
      const chosen = localChanged ? localValue : remoteValue;
      if (chosen !== undefined) value[key] = chosen;
    }
    if (conflicts.length) return { ok: false, conflicts };
    return { ok: true, value, conflicts: [] };
  }

  return { ok: false, conflicts: ['concurrent-field-change'] };
}
