import { useEffect, useRef, useCallback } from 'react';
import useStore, { getSerializableState } from '../store/useStore';
import { LocalAdapter } from '../storage/localAdapter.js';
import { DriveAdapter } from '../storage/driveAdapter.js';
import { OneDriveAdapter } from '../storage/oneDriveAdapter.js';
import { SyncManager } from '../storage/syncManager.js';
import { getTokens, clearTokens } from '../auth/tokenStore.js';
import { startGoogleAuth, handleGoogleCallback, getPkceStorage } from '../auth/google.js';
import { startMicrosoftAuth, handleMicrosoftCallback } from '../auth/microsoft.js';
import { AuthExpiredError } from '../auth/errors.js';
import {
  migrateFromLocalStorage,
  serializeToFiles,
  deserializeFromFiles,
  cleanupLocalStorage,
} from '../storage/migrations.js';
import { writeSnapshot, ensureSnapshotIntegrity } from '../storage/agentSnapshot.js';
import { getObsidianAdapter } from '../utils/obsidianAdapter.js';
import { isTauri } from '../utils/platform.js';

const SNAPSHOT_DEBOUNCE_MS = 500;

/**
 * Core sync hook that wires IndexedDB storage, optional cloud adapters,
 * and the Zustand store together. Call once near the root of the app.
 */
export function useSync() {
  const syncManagerRef = useRef(null);
  const localAdapterRef = useRef(null);
  const cloudAdapterRef = useRef(null);
  const unsubRef = useRef(null);
  const prevSnapshotRef = useRef(null);

  // ── Initialization (runs once on mount) ──
  useEffect(() => {
    let destroyed = false;

    async function init() {
      try {
        // 1. Create local adapter
        const localAdapter = new LocalAdapter();

        // 2. Migrate from localStorage or load from IndexedDB
        let hydrateData;
        const migrated = await migrateFromLocalStorage();

        if (migrated) {
          hydrateData = migrated;
        } else {
          // Load all files from IndexedDB and deserialize
          const filenames = await localAdapter.list();
          if (filenames.length > 0) {
            const fileMap = {};
            for (const name of filenames) {
              const data = await localAdapter.load(name);
              if (data !== null) fileMap[name] = data;
            }
            hydrateData = deserializeFromFiles(fileMap);
          }
        }

        // 3. Hydrate the store
        if (hydrateData && !destroyed) {
          useStore.getState()._hydrateState(hydrateData);
          // IndexedDB has data — safe to remove legacy localStorage key
          cleanupLocalStorage();
        } else if (!destroyed) {
          // Nothing to load — just mark hydrated
          useStore.getState()._hydrateState({});
        }

        // 4. Handle OAuth callback if present
        // Check URL params — works in both browser and Tauri dev (localhost redirect)
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        const state = params.get('state');

        if (code) {
          // In Tauri, PKCE state is in localStorage; in browser, sessionStorage
          const provider = getPkceStorage('oauth_provider');
          try {
            if (provider === 'google') {
              await handleGoogleCallback(code, state);
            } else if (provider === 'microsoft') {
              await handleMicrosoftCallback(code, state);
            }
          } catch (err) {
            console.error('[useSync] OAuth callback failed:', err);
          }
          // Clean the URL regardless of success
          window.history.replaceState({}, '', window.location.pathname);
        }

        // In Tauri, register the deep-link handler so OAuth callbacks return
        // via com.taskplanner.app:/auth/callback (see src/auth/google.js,
        // microsoft.js). Google's iOS OAuth client requires the scheme to
        // match the bundle ID exactly.
        if (isTauri()) {
          try {
            const dl = await import('@tauri-apps/plugin-deep-link');
            // register() ensures the scheme is bound at runtime for tauri:dev
            // and Linux; it's a no-op when the OS already has the scheme
            // registered (e.g. via the installer on Windows/macOS).
            try {
              await dl.register('com.taskplanner.app');
              console.log('[useSync] Deep-link scheme registered to current exe');
            } catch (err) {
              console.error('[useSync] dl.register failed:', err);
            }

            const handleDeepLinkUrl = async (rawUrl) => {
              console.log('[useSync] Deep-link received:', rawUrl);
              try {
                const url = new URL(rawUrl);
                const dlCode = url.searchParams.get('code');
                const dlState = url.searchParams.get('state');
                if (!dlCode) {
                  console.warn('[useSync] Deep-link had no `code` param — ignoring');
                  return;
                }

                const provider = getPkceStorage('oauth_provider');
                console.log('[useSync] Exchanging deep-link code for', provider, 'tokens');
                if (provider === 'google') {
                  await handleGoogleCallback(dlCode, dlState);
                } else if (provider === 'microsoft') {
                  await handleMicrosoftCallback(dlCode, dlState);
                } else {
                  console.warn('[useSync] No oauth_provider stored — cannot exchange code');
                  return;
                }
                console.log('[useSync] Token exchange succeeded — reloading');
                window.location.reload();
              } catch (err) {
                console.error('[useSync] Tauri deep-link OAuth failed:', err);
              }
            };

            // Cold start: the app may have been launched by the deep link itself
            // (Windows/Linux first-instance). getCurrent() returns those URLs.
            try {
              const initial = await dl.getCurrent();
              if (initial && initial.length > 0) {
                console.log('[useSync] Deep-link cold-start URLs:', initial);
                await handleDeepLinkUrl(initial[0]);
              }
            } catch (err) {
              console.error('[useSync] getCurrent() failed:', err);
            }

            // Warm: subsequent deep links (running app, second-instance forwarded
            // by tauri-plugin-single-instance — see src-tauri/src/main.rs).
            dl.onOpenUrl((urls) => {
              if (urls && urls.length > 0) handleDeepLinkUrl(urls[0]);
            });
          } catch (err) {
            console.error('[useSync] Failed to register deep-link handler:', err);
          }
        }

        // 5. Check for existing cloud tokens and create adapter
        let cloudAdapter = null;
        try {
          const googleTokens = await getTokens('google');
          if (googleTokens) {
            cloudAdapter = new DriveAdapter();
            useStore.getState().setCloudProvider('google');
          } else {
            const msTokens = await getTokens('microsoft');
            if (msTokens) {
              cloudAdapter = new OneDriveAdapter();
              useStore.getState().setCloudProvider('microsoft');
            }
          }
        } catch (err) {
          console.error('[useSync] Failed to check cloud tokens:', err);
        }

        // 6. Create SyncManager
        const syncManager = new SyncManager(localAdapter, cloudAdapter);
        syncManager.onStatusChange = (status) => {
          useStore.getState().setSyncStatus(status);
        };
        // When OAuth refresh definitively fails (invalid_grant), drop the
        // cloud session so the UI honestly shows "Connect Google Drive"
        // again instead of a green "Connected" badge over a dead token.
        // See src/auth/errors.js for why this exists.
        syncManager.onAuthError = async (err) => {
          const provider = err?.provider;
          console.warn(`[useSync] Auth expired for ${provider} — clearing cloud session`);
          try {
            if (provider) await clearTokens(provider);
          } catch (clearErr) {
            console.error('[useSync] Failed to clear tokens:', clearErr);
          }
          useStore.getState().setCloudProvider(null);
          useStore.getState().setCloudVerified(false);
          useStore.getState().setSyncStatus('error');
          cloudAdapterRef.current = null;
        };

        if (destroyed) {
          syncManager.destroy();
          return;
        }
        syncManagerRef.current = syncManager;
        localAdapterRef.current = localAdapter;
        cloudAdapterRef.current = cloudAdapter;

        // 7. Pull and merge from cloud if connected
        if (cloudAdapter) {
          // Show amber "Syncing…" header dot while the first cloud probe
          // runs — keeps the UI honest. The badge in ConnectStorage is
          // gated on cloudVerified separately.
          useStore.getState().setSyncStatus('syncing');
          try {
            // Gather filenames from both local and cloud so a fresh device
            // picks up remote-only files (fixes first-sync-on-new-device bug)
            const [localNames, cloudNames] = await Promise.all([
              localAdapter.list(),
              cloudAdapter.list(),
            ]);
            const allNames = [...new Set([...localNames, ...cloudNames])];

            if (allNames.length > 0) {
              // Pull all files in parallel to avoid sequential round-trips
              const results = await Promise.all(
                allNames.map(async (name) => {
                  const merged = await syncManager.pullAndMerge(name);
                  return [name, merged];
                }),
              );
              const mergedFileMap = {};
              for (const [name, merged] of results) {
                if (merged !== null) mergedFileMap[name] = merged;
              }
              const mergedState = deserializeFromFiles(mergedFileMap);
              if (!destroyed) {
                useStore.getState()._hydrateState(mergedState);
              }
            }
            // pullAndMerge swallows non-auth errors and falls back to local;
            // check authBroken to confirm the round-trip actually succeeded
            // before flipping the badge to green "Connected".
            if (!destroyed && !syncManager.authBroken) {
              useStore.getState().setCloudVerified(true);
              useStore.getState().setSyncStatus('idle');
            }
          } catch (err) {
            // If the cloud refresh token is dead, tear the session down
            // immediately so the UI shows "Connect Google Drive" instead
            // of a green "Connected" badge during the very first session
            // after expiry.
            if (err instanceof AuthExpiredError) {
              syncManager.handleAuthError(err);
            } else {
              console.error('[useSync] Cloud pull-and-merge failed:', err);
              useStore.getState().setSyncStatus('error');
            }
          }
        }

        // 7.5. Snapshot integrity check (Tauri only). If snapshot.json is
        //      missing, unparseable, or its exportedAt disagrees with
        //      snapshot.meta.json, force a fresh write from the in-memory
        //      store. This is the recovery path that was missing — without
        //      it, a corrupt body file would persist across reboots until
        //      the user happened to make a store change. See bug report
        //      "Bug 1 — Snapshot exporter: meta advances without body".
        if (isTauri()) {
          try {
            const adapter = await getObsidianAdapter();
            const current = useStore.getState();
            const result = await ensureSnapshotIntegrity(adapter, current, {
              plannerDataPath: current.obsidianConfig?.plannerDataPath,
            });
            if (result.status === 'rewritten') {
              console.warn(`[useSync] snapshot integrity: re-wrote (${result.reason})`);
            }
          } catch (err) {
            console.error('[useSync] snapshot integrity check failed:', err);
          }
        }

        // 8. Subscribe to store changes for auto-saving
        let snapshotTimer = null;
        const unsub = useStore.subscribe((state, prevState) => {
          if (!syncManagerRef.current) return;

          // Only save when core data actually changes (by reference)
          const changed =
            state.projects !== prevState.projects ||
            state.sprints !== prevState.sprints ||
            state.tasks !== prevState.tasks ||
            state.obsidianConfig !== prevState.obsidianConfig;

          if (!changed) return;

          // Agent snapshot write (Tauri only for now — browser adapter no-ops).
          // Debounced so a bulk op writes the file once, not N times.
          // Every attempt is logged to agent-log/YYYY-MM-DD.jsonl so we can
          // tell from the file system that the writer is alive even on days
          // with no agent ops — the bug report flagged "no 2026-05-06.jsonl
          // exists despite the app being open".
          if (isTauri()) {
            if (snapshotTimer) clearTimeout(snapshotTimer);
            snapshotTimer = setTimeout(async () => {
              const startMs = Date.now();
              const dateStr = new Date(startMs).toISOString().slice(0, 10);
              const logRel = `agent-log/${dateStr}.jsonl`;
              let adapter;
              const current = useStore.getState();
              const plannerDataPath = current.obsidianConfig?.plannerDataPath;
              let snap = null;
              let err = null;
              try {
                adapter = await getObsidianAdapter();
                snap = await writeSnapshot(adapter, current, { plannerDataPath });
              } catch (writeErr) {
                err = writeErr;
                console.error('[useSync] Snapshot write failed:', writeErr);
              }
              if (adapter && typeof adapter.appendAgentFile === 'function') {
                const line = JSON.stringify({
                  type: 'snapshot.write',
                  ts: startMs,
                  durationMs: Date.now() - startMs,
                  status: err ? 'error' : 'ok',
                  exportedAt: snap?.exportedAt ?? null,
                  taskCount: snap?.tasks?.length ?? null,
                  error: err ? String(err?.message || err) : null,
                }) + '\n';
                try {
                  await adapter.appendAgentFile(logRel, line, plannerDataPath);
                } catch (logErr) {
                  console.error('[useSync] Snapshot log write failed:', logErr);
                }
              }
            }, SNAPSHOT_DEBOUNCE_MS);
          }

          const serializable = getSerializableState(state);
          const { projects, sprints, tasks, obsidianConfig } = serializable;
          const files = serializeToFiles(
            projects || [],
            sprints || [],
            tasks || [],
            obsidianConfig || null,
          );

          // Detect deleted projects by comparing project IDs between states.
          // Delete orphaned project-{id}.json files from both local and cloud.
          const prevProjectIds = new Set((prevState.projects || []).map((p) => p.id));
          const currProjectIds = new Set((state.projects || []).map((p) => p.id));
          for (const prevId of prevProjectIds) {
            if (!currProjectIds.has(prevId)) {
              const filename = `project-${prevId}.json`;
              localAdapterRef.current?.delete(filename).catch((err) => {
                console.error(`[useSync] Failed to delete local ${filename}:`, err);
              });
              cloudAdapterRef.current?.delete(filename).catch((err) => {
                console.error(`[useSync] Failed to delete cloud ${filename}:`, err);
              });
            }
          }

          for (const [filename, data] of Object.entries(files)) {
            syncManagerRef.current.save(filename, data).catch((err) => {
              console.error(`[useSync] Failed to save ${filename}:`, err);
            });
          }
        });

        unsubRef.current = unsub;
      } catch (err) {
        console.error('[useSync] Initialization failed:', err);
        // Ensure hydrated is set even on failure so the app doesn't hang
        if (!destroyed) {
          useStore.getState()._hydrateState({});
        }
      }
    }

    init();

    return () => {
      destroyed = true;
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      if (syncManagerRef.current) {
        syncManagerRef.current.destroy();
        syncManagerRef.current = null;
      }
    };
  }, []);

  // ── Public API ──
  const connectGoogle = useCallback(() => {
    startGoogleAuth();
  }, []);

  const connectMicrosoft = useCallback(() => {
    startMicrosoftAuth();
  }, []);

  const disconnect = useCallback(async (provider) => {
    await clearTokens(provider);
    window.location.reload();
  }, []);

  const refresh = useCallback(async () => {
    const syncManager = syncManagerRef.current;
    const localAdapter = localAdapterRef.current;
    const cloudAdapter = cloudAdapterRef.current;
    if (!syncManager || !cloudAdapter || !navigator.onLine) return;
    if (useStore.getState().syncStatus === 'syncing') return;

    try {
      useStore.getState().setSyncStatus('syncing');
      let localNames = [];
      let cloudNames = [];
      try {
        [localNames, cloudNames] = await Promise.all([
          localAdapter.list(),
          cloudAdapter.list(),
        ]);
      } catch (listErr) {
        // cloudAdapter.list() re-throws AuthExpiredError now. Route it
        // through syncManager so the onAuthError teardown fires; status
        // becomes 'error' and the early-return check below skips the
        // green-light overwrite.
        if (listErr instanceof AuthExpiredError) {
          syncManager.handleAuthError(listErr);
        } else {
          throw listErr;
        }
      }
      const allNames = [...new Set([...localNames, ...cloudNames])];
      if (allNames.length > 0) {
        const results = await Promise.all(
          allNames.map(async (name) => {
            const merged = await syncManager.pullAndMerge(name);
            return [name, merged];
          }),
        );
        const mergedFileMap = {};
        for (const [name, merged] of results) {
          if (merged !== null) mergedFileMap[name] = merged;
        }
        const mergedState = deserializeFromFiles(mergedFileMap);
        useStore.getState()._hydrateState(mergedState);
      }
      // Only paint green if the cloud round-trip actually succeeded.
      // pullAndMerge / list propagate AuthExpiredError → onAuthError →
      // setSyncStatus('error'); don't clobber that back to idle.
      if (!syncManager.authBroken && useStore.getState().syncStatus !== 'error') {
        useStore.getState().setCloudVerified(true);
        useStore.getState().setSyncStatus('idle');
      }
    } catch (err) {
      console.error('[useSync] Manual refresh failed:', err);
      useStore.getState().setSyncStatus('error');
    }
  }, []);

  return { connectGoogle, connectMicrosoft, disconnect, refresh };
}
