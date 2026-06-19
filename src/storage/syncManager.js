import { debounce } from '../utils/debounce.js';
import { mergeData } from '../utils/merge.js';
import { AuthExpiredError } from '../auth/errors.js';

export class SyncManager {
  /**
   * @param {import('./adapter.js').StorageAdapter} localAdapter
   * @param {import('./adapter.js').StorageAdapter | null} cloudAdapter
   */
  constructor(localAdapter, cloudAdapter = null) {
    this.local = localAdapter;
    this.cloud = cloudAdapter;
    this.pendingUploads = new Set();
    this.status = 'idle';
    this.onStatusChange = null;
    // Fired the first time an OAuth refresh returns invalid_grant. The hook
    // wires this to clearTokens() + setCloudProvider(null) so the UI stops
    // showing a green "Connected" badge over a dead refresh token.
    this.onAuthError = null;
    this._authBroken = false;

    // Per-file debounce so rapid saves of different files don't cancel each other
    this._debouncedUploads = new Map();
    this._getOrCreateDebounce = (filename) => {
      if (!this._debouncedUploads.has(filename)) {
        this._debouncedUploads.set(
          filename,
          debounce(() => this._upload(filename), 2000),
        );
      }
      return this._debouncedUploads.get(filename);
    };

    // Bind event handlers so they can be removed later
    this._onBeforeUnload = () => this.flushAll();
    this._onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this.flushAll();
    };
    this._onOnline = () => this.flushAll();

    window.addEventListener('beforeunload', this._onBeforeUnload);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    window.addEventListener('online', this._onOnline);
  }

  setStatus(status) {
    this.status = status;
    if (this.onStatusChange) {
      try {
        this.onStatusChange(status);
      } catch (err) {
        console.error('[SyncManager] onStatusChange callback error:', err);
      }
    }
  }

  /**
   * Called when a cloud call returns AuthExpiredError. Marks auth as
   * broken (so subsequent pull/upload attempts short-circuit) and notifies
   * the host hook to clear tokens and reset the UI. Idempotent — fires
   * the callback at most once per manager instance.
   *
   * Public so callers that go around SyncManager (e.g. useSync.refresh
   * calling cloudAdapter.list directly) can still report the auth failure.
   */
  handleAuthError(err) {
    if (this._authBroken) return;
    this._authBroken = true;
    this.setStatus('error');
    if (this.onAuthError) {
      try {
        this.onAuthError(err);
      } catch (cbErr) {
        console.error('[SyncManager] onAuthError callback error:', cbErr);
      }
    }
  }

  get authBroken() { return this._authBroken; }

  /**
   * Save data locally (immediately) and queue a debounced cloud upload.
   */
  async save(filename, data) {
    await this.local.save(filename, data);

    if (this.cloud) {
      this.pendingUploads.add(filename);
      this._getOrCreateDebounce(filename)();
    }
  }

  /**
   * Upload a single file to the cloud adapter.
   * @private
   */
  async _upload(filename) {
    if (!navigator.onLine) {
      this.setStatus('offline');
      return;
    }
    if (this._authBroken) {
      // Cloud session is already known dead — don't waste retries.
      this.setStatus('error');
      return;
    }

    const MAX_ATTEMPTS = 3;
    const BASE_DELAY_MS = 1000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        this.setStatus('syncing');
        const data = await this.local.load(filename);
        if (data !== null) {
          await this.cloud.save(filename, data);
        }
        this.pendingUploads.delete(filename);

        if (this.pendingUploads.size === 0) {
          this.setStatus('idle');
        }
        return; // success
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          console.error(`[SyncManager] Auth expired uploading ${filename}, not retrying:`, err);
          this.handleAuthError(err);
          return;
        }

        console.error(`[SyncManager] Upload attempt ${attempt}/${MAX_ATTEMPTS} failed for ${filename}:`, err);

        if (attempt < MAX_ATTEMPTS) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          this.setStatus('error');
        }
      }
    }
  }

  /**
   * Immediately flush all pending uploads (e.g. before page unload).
   */
  flushAll() {
    const uploads = [...this.pendingUploads].map((filename) =>
      this._upload(filename)
    );
    return Promise.allSettled(uploads);
  }

  /**
   * Pull remote data and merge with local using last-write-wins.
   * Returns the winning data.
   */
  async pullAndMerge(filename) {
    if (!this.cloud || !navigator.onLine || this._authBroken) {
      return this.local.load(filename);
    }

    try {
      const [localData, remoteData] = await Promise.all([
        this.local.load(filename),
        this.cloud.load(filename),
      ]);

      const merged = mergeData(localData, remoteData);

      // Persist the winner to whichever side lost
      if (merged === remoteData && remoteData !== null) {
        await this.local.save(filename, remoteData);
      } else if (merged === localData && localData !== null && remoteData !== null) {
        // Local won — push to cloud so remote is up to date
        await this.cloud.save(filename, localData);
      }

      return merged;
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        // Don't silently fall back — the UI must learn the cloud session is
        // dead. Mark broken, fire the teardown callback, return local copy
        // so the caller's hydrate path still works.
        console.error(`[SyncManager] Auth expired during pullAndMerge for ${filename}:`, err);
        this.handleAuthError(err);
        return this.local.load(filename);
      }
      console.error(`[SyncManager] pullAndMerge failed for ${filename}:`, err);
      // Fall back to local data for transient/network errors
      return this.local.load(filename);
    }
  }

  /**
   * Clean up event listeners.
   */
  destroy() {
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('online', this._onOnline);
  }
}
