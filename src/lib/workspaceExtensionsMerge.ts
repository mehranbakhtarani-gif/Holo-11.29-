/** Preserve fallback only when a cloud field is absent or malformed.
 * An explicitly empty array is a valid remote value and must clear local items.
 */
export function mergeRemoteArray<T>(remote: unknown, fallback: readonly T[]): T[] {
  return Array.isArray(remote) ? (remote as T[]) : [...fallback];
}
