/**
 * Per-op-type trust decisions.
 *
 * Defaults match CLAUDE_AGENT_PROTOCOL.md §5. The user can override via
 * `obsidianConfig.agentTrust` (a partial map keyed by op type → 'auto' | 'queue').
 * For `bulk` envelopes the decision is the strictest of its children:
 * any single child queued ⇒ the whole bulk queues.
 */

export const DEFAULT_TRUST = Object.freeze({
  'task.add':       'auto',
  'task.update':    'auto',
  'task.delete':    'queue',
  'sprint.add':     'auto',
  'sprint.update':  'auto',
  'sprint.delete':  'queue',
  'project.add':    'auto',
  'project.update': 'auto',
  'project.delete': 'queue',
});

function resolveOverride(override) {
  if (!override || typeof override !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(override)) {
    if (v === 'auto' || v === 'queue') out[k] = v;
  }
  return out;
}

/**
 * Decision for a single atomic op type.
 */
export function decide(opType, override) {
  const o = resolveOverride(override);
  if (Object.prototype.hasOwnProperty.call(o, opType)) return o[opType];
  return DEFAULT_TRUST[opType] || 'auto';
}

/**
 * Decision for a list of atomic ops (the flattened form of any envelope).
 * 'queue' wins over 'auto'.
 */
export function decideForBulk(ops, override) {
  for (const op of ops) {
    if (decide(op.type, override) === 'queue') return 'queue';
  }
  return 'auto';
}
