/**
 * Platform-adapter factory for the agent-file channel ($PLANNER_DATA_DIR).
 *
 * Both adapters export the same interface:
 *   - resolvePlannerDataDir(override) → root path string
 *   - writeAgentFile(relPath, contents, plannerDataPath)
 *   - readAgentFile(absPath)
 *   - removeAgentFile(absPath)
 *   - appendAgentFile(relPath, contents, plannerDataPath)
 *   - listAgentFiles(relDir, plannerDataPath, opts) → [{ name, absPath, modifiedAt }]
 *
 * The "obsidian" name is back-compat — bidirectional Obsidian vault sync
 * was removed; this factory now only services the agent file channel.
 */

import { isTauri } from './platform.js';

let adapter;

export async function getObsidianAdapter() {
  if (adapter) return adapter;
  if (isTauri()) {
    adapter = await import('./obsidianTauri.js');
  } else {
    adapter = await import('./obsidianBrowser.js');
  }
  return adapter;
}
