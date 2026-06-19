/**
 * Abstract storage adapter. All adapters (IndexedDB, Google Drive)
 * implement this interface so the SyncManager can treat them uniformly.
 */
export class StorageAdapter {
  /** Save JSON-serializable `data` under `filename`. */
  async save(filename, data) { throw new Error('Not implemented'); }

  /** Load and return parsed data for `filename`, or null if not found. */
  async load(filename) { throw new Error('Not implemented'); }

  /** Return an array of all stored filenames. */
  async list() { throw new Error('Not implemented'); }

  /** Delete the file with the given `filename`. */
  async delete(filename) { throw new Error('Not implemented'); }
}
