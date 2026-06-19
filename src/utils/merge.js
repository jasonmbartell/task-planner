/**
 * Last-write-wins merge for single-user sync.
 * Both `local` and `remote` must have an `updatedAt` timestamp (ms).
 * Returns whichever copy is newer, or local if equal.
 */
export function mergeData(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  return remote.updatedAt > local.updatedAt ? remote : local;
}
