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
