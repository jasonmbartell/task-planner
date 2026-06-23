/**
 * Tauri implementation of the agent-file channel. Reads, writes, lists, and
 * appends the JSON / JSONL files under $PLANNER_DATA_DIR (agent-inbox,
 * agent-archive, agent-log).
 *
 * Bidirectional Obsidian vault sync was removed; this module kept its
 * "obsidian" name for back-compat with the platform-adapter factory.
 */

import {
  readDir,
  readTextFile,
  writeTextFile,
  mkdir,
  stat,
  exists,
  rename,
  remove,
} from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';

/**
 * Resolve the root directory for agent files ($PLANNER_DATA_DIR).
 * Prefers the user override (obsidianConfig.plannerDataPath); otherwise
 * defaults to Tauri's app_data_dir() joined with "planner-data".
 */
export async function resolvePlannerDataDir(override) {
  if (override && typeof override === 'string' && override.trim()) {
    return override.trim();
  }
  const base = await appDataDir();
  return await join(base, 'planner-data');
}

/**
 * Atomically write a file rooted at $PLANNER_DATA_DIR. Creates the root
 * (and agent-inbox / agent-archive / agent-log subdirs the first time) so
 * the watcher and agent always see a well-formed layout.
 */
export async function writeAgentFile(relPath, contents, plannerDataPath) {
  const root = await resolvePlannerDataDir(plannerDataPath);
  await mkdir(root, { recursive: true });

  // Ensure the protocol-standard subdirs exist on first write.
  for (const sub of ['agent-inbox', 'agent-archive', 'agent-archive/applied',
                     'agent-archive/queued', 'agent-archive/rejected', 'agent-log']) {
    await mkdir(await join(root, sub), { recursive: true }).catch(() => {});
  }

  const normalized = relPath.replace(/\\/g, '/');
  const dest = await join(root, normalized);

  // If the rel path contains subdirs, ensure the parent exists.
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash > 0) {
    await mkdir(await join(root, normalized.slice(0, lastSlash)), { recursive: true }).catch(() => {});
  }

  // Atomic write: write the full body to a temp file, then rename() it over
  // the destination. The Tauri fs plugin's rename maps to std::fs::rename,
  // which atomically REPLACES an existing file on both Windows and Unix — it
  // swaps the directory entry, it does not overwrite bytes in place. That's
  // what prevents the "a shorter export leaves the previous body's tail (plus
  // NUL padding) behind" corruption: a smaller new body can never leave the
  // larger old body's tail, because the old file is unlinked wholesale rather
  // than partially overwritten. It also closes the partial-read window a
  // reader (the agent) could otherwise hit mid-write.
  //
  // We deliberately do NOT remove(dest) before the rename. rename already
  // replaces it, and removing first would open a window where snapshot.json
  // briefly doesn't exist — the missing-file/partial-read risk we're avoiding.
  const tmp = `${dest}.tmp`;
  await writeTextFile(tmp, contents);
  try {
    await rename(tmp, dest);
  } catch (err) {
    // rename can still fail if dest is held open without FILE_SHARE_DELETE
    // (e.g. an AV scanner on Windows). Fall back to a direct write; the plugin
    // opens with truncate by default, so even this path can't leave a stale
    // tail — it just isn't atomic.
    console.warn(`[obsidian/tauri] atomic rename failed for ${dest}, falling back to direct truncating write:`, err);
    await writeTextFile(dest, contents);
    await remove(tmp).catch(() => {});
  }
  return dest;
}

/**
 * Read an agent file by absolute path. Used by the inbox watcher path
 * (the watcher hands back absolute paths it observed).
 */
export async function readAgentFile(absPath) {
  return await readTextFile(absPath);
}

/**
 * Delete an agent file by absolute path. The inbox apply path uses this
 * to clear the inbox after archiving.
 */
export async function removeAgentFile(absPath) {
  await remove(absPath);
}

/**
 * List files inside a relative-path directory under $PLANNER_DATA_DIR.
 * Used by the inbox UI (Milestone 4) to enumerate `agent-archive/queued/`
 * and the digest view (Milestone 5) to enumerate `agent-log/`. Returns
 * `[{ name, absPath, modifiedAt }]`, sorted newest-first by mtime (files
 * without mtime fall to the bottom, stable order). Missing directory →
 * empty list (we don't want to surface it as an error).
 *
 * Pass `{ ext: '.jsonl' }` to match a non-default extension; default is
 * `.json`. The comparison is case-insensitive.
 */
export async function listAgentFiles(relDir, plannerDataPath, { ext = '.json' } = {}) {
  const root = await resolvePlannerDataDir(plannerDataPath);
  const normalized = (relDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const dir = normalized ? await join(root, normalized) : root;
  try {
    if (!(await exists(dir))) return [];
  } catch {
    return [];
  }
  let entries;
  try {
    entries = await readDir(dir);
  } catch (err) {
    console.warn(`[obsidian/tauri] failed to list ${dir}:`, err);
    return [];
  }
  const wanted = String(ext || '').toLowerCase();
  const out = [];
  for (const entry of entries) {
    if (!entry.name || entry.isDirectory) continue;
    if (wanted && !entry.name.toLowerCase().endsWith(wanted)) continue;
    const absPath = await join(dir, entry.name);
    let modifiedAt = 0;
    try {
      const st = await stat(absPath);
      if (st?.mtime) modifiedAt = new Date(st.mtime).getTime();
    } catch {
      // best-effort mtime
    }
    out.push({ name: entry.name, absPath, modifiedAt });
  }
  out.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  return out;
}

/**
 * Read snapshot.json and snapshot.meta.json from $PLANNER_DATA_DIR for the
 * boot-time integrity check. Missing files surface as `null` (not an error)
 * so the caller can decide whether a missing body warrants a rewrite or
 * just signals first launch.
 */
export async function readSnapshotPair(plannerDataPath) {
  const root = await resolvePlannerDataDir(plannerDataPath);
  const bodyAbs = await join(root, 'snapshot.json');
  const metaAbs = await join(root, 'snapshot.meta.json');
  let body = null;
  let meta = null;
  try {
    if (await exists(bodyAbs)) body = await readTextFile(bodyAbs);
  } catch (err) {
    console.warn('[obsidian/tauri] readSnapshotPair: body read failed:', err);
    body = null;
  }
  try {
    if (await exists(metaAbs)) meta = await readTextFile(metaAbs);
  } catch (err) {
    console.warn('[obsidian/tauri] readSnapshotPair: meta read failed:', err);
    meta = null;
  }
  return { body, meta };
}

/**
 * Append a line to a relative-path file rooted at $PLANNER_DATA_DIR.
 * Used for `agent-log/YYYY-MM-DD.jsonl`. Each call adds one line; caller
 * is responsible for the trailing newline.
 */
export async function appendAgentFile(relPath, contents, plannerDataPath) {
  const root = await resolvePlannerDataDir(plannerDataPath);
  await mkdir(root, { recursive: true });

  const normalized = relPath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash > 0) {
    await mkdir(await join(root, normalized.slice(0, lastSlash)), { recursive: true }).catch(() => {});
  }
  const dest = await join(root, normalized);

  // tauri-plugin-fs supports `{ append: true }`. If the file doesn't exist,
  // it's created. Single-writer append-only is trivially safe.
  await writeTextFile(dest, contents, { append: true });
  return dest;
}
