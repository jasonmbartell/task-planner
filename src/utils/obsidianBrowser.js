/**
 * Browser stub for the agent-file channel. The agent inbox / archive / log
 * lives on the local filesystem; the browser build can't write to it, so
 * every entry point is a logged no-op. The Tauri build (obsidianTauri.js)
 * is the real implementation.
 *
 * This module exists for the platform-adapter factory in `obsidianAdapter.js`
 * — bidirectional Obsidian vault sync was removed; the file kept its
 * "obsidian" name for back-compat with that factory.
 */

let _agentWriteWarned = false;
function warnOnceAgentNoop() {
  if (!_agentWriteWarned) {
    _agentWriteWarned = true;
    console.info('[obsidian/browser] Agent snapshot/file writes are only active in the Tauri build.');
  }
}

export async function writeAgentFile(_relPath, _contents, _plannerDataPath) {
  warnOnceAgentNoop();
  return null;
}

export async function readAgentFile(_absPath) {
  warnOnceAgentNoop();
  return null;
}

export async function removeAgentFile(_absPath) {
  warnOnceAgentNoop();
}

export async function appendAgentFile(_relPath, _contents, _plannerDataPath) {
  warnOnceAgentNoop();
  return null;
}

export async function listAgentFiles(_relDir, _plannerDataPath, _opts) {
  warnOnceAgentNoop();
  return [];
}

export async function resolvePlannerDataDir() {
  return '';
}

export async function readSnapshotPair(_plannerDataPath) {
  return { body: null, meta: null };
}
