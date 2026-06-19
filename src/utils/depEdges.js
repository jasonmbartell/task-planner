/**
 * Typed dependency edges.
 *
 * A task's `dependencies` field is a list of `DepEdge` objects:
 *   { targetId, type, except?, note? }
 *
 *   - `hard-blocks`          classic blocker. This task cannot start until the target is done.
 *                            Counts for cycle detection and critical path.
 *   - `soft-prefers`         preference, not a block. "Do X before Y if you can."
 *                            Ignored by cycle detection and critical path.
 *   - `preempts`             target preempts this task. "Whenever high-priority work is available,
 *                            drop lower-priority work." Ignored by cycle detection.
 *   - `deadline-independent` scheduling relationship but does not extend the critical path.
 *                            Ignored by cycle detection.
 *
 * Legacy data and all inputs that pre-date this milestone stored
 * `dependencies: string[]`. Those are still accepted on input — bare
 * strings normalize to `hard-blocks` edges — so the migration and all
 * helpers here are idempotent.
 *
 * Spec: docs/claude-agent-integration.md §7 Milestone 3.5.
 */

export const DEFAULT_EDGE_TYPE = 'hard-blocks';

export const EDGE_TYPES = Object.freeze([
  'hard-blocks',
  'soft-prefers',
  'preempts',
  'deadline-independent',
]);

const EDGE_TYPE_SET = new Set(EDGE_TYPES);

// Accept short aliases in markdown and legacy inputs.
const EDGE_TYPE_ALIASES = Object.freeze({
  hard: 'hard-blocks',
  'hard-block': 'hard-blocks',
  'hard-blocks': 'hard-blocks',
  blocks: 'hard-blocks',
  blocker: 'hard-blocks',
  soft: 'soft-prefers',
  'soft-prefer': 'soft-prefers',
  'soft-prefers': 'soft-prefers',
  prefer: 'soft-prefers',
  prefers: 'soft-prefers',
  preempt: 'preempts',
  preempts: 'preempts',
  preemptive: 'preempts',
  independent: 'deadline-independent',
  'deadline-independent': 'deadline-independent',
  'no-schedule': 'deadline-independent',
});

export function isValidEdgeType(type) {
  return typeof type === 'string' && EDGE_TYPE_SET.has(type);
}

/**
 * Canonicalize an edge-type string. Accepts full names and common aliases.
 * Returns the canonical name or null if unrecognized.
 */
export function canonicalEdgeType(type) {
  if (typeof type !== 'string') return null;
  const key = type.trim().toLowerCase();
  if (!key) return null;
  return EDGE_TYPE_ALIASES[key] || (EDGE_TYPE_SET.has(key) ? key : null);
}

/**
 * Coerce a single dep (bare string, legacy object, or full DepEdge) into a
 * normalized `{ targetId, type, ...optional }` edge. Returns null when the
 * input can't be turned into a valid edge (missing targetId, etc.).
 */
export function normalizeDep(dep, { defaultType = DEFAULT_EDGE_TYPE } = {}) {
  if (!dep) return null;

  if (typeof dep === 'string') {
    const targetId = dep.trim();
    if (!targetId) return null;
    return { targetId, type: defaultType };
  }

  if (typeof dep !== 'object') return null;

  const targetId = typeof dep.targetId === 'string' ? dep.targetId.trim() : '';
  if (!targetId) return null;

  const type = canonicalEdgeType(dep.type) || defaultType;
  const edge = { targetId, type };
  if (typeof dep.except === 'string' && dep.except.trim()) edge.except = dep.except.trim();
  if (typeof dep.note === 'string' && dep.note.trim()) edge.note = dep.note.trim();
  return edge;
}

/**
 * Normalize an array of mixed-shape deps. Drops duplicates (by targetId+type)
 * and anything that `normalizeDep` rejects.
 */
export function normalizeDeps(list, opts = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const edge = normalizeDep(raw, opts);
    if (!edge) continue;
    const key = `${edge.targetId}::${edge.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/**
 * Accept either a DepEdge[] or a legacy string[] and always return DepEdge[].
 * Used during migration and when reading legacy vault data.
 */
export function coerceToEdges(list, opts = {}) {
  return normalizeDeps(list, opts);
}

/**
 * Target IDs for edges whose type is `hard-blocks` — what cycle detection and
 * critical-path care about. Bare strings are treated as hard-blocks (their
 * normalizeDep default), so legacy data still works without an up-front
 * migration pass.
 */
export function hardTargets(edges) {
  if (!Array.isArray(edges)) return [];
  const out = [];
  for (const e of edges) {
    if (typeof e === 'string') {
      const id = e.trim();
      if (id) out.push(id);
    } else if (e && e.targetId && e.type === 'hard-blocks') {
      out.push(e.targetId);
    }
  }
  return out;
}

/** All target IDs, regardless of edge type. Tolerates legacy string entries. */
export function edgeTargets(edges) {
  if (!Array.isArray(edges)) return [];
  const out = [];
  for (const e of edges) {
    if (typeof e === 'string') {
      const id = e.trim();
      if (id) out.push(id);
    } else if (e && e.targetId) {
      out.push(e.targetId);
    }
  }
  return out;
}

/** Strip every edge pointing at `targetId`. Tolerates legacy string entries. */
export function removeTarget(edges, targetId) {
  if (!Array.isArray(edges)) return [];
  return edges.filter((e) => {
    if (typeof e === 'string') return e.trim() !== targetId;
    return e && e.targetId !== targetId;
  });
}

/**
 * Markdown tokens: `task-abc` (implicit hard), or `task-abc (soft)`,
 * `task-abc (preempts)`, etc. Annotations may use full or short names.
 * Returns a DepEdge or null.
 */
export function parseEdgeToken(token) {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed) return null;

  // Optional trailing annotation in parens: "task-abc (soft)" or "task-abc (type: soft, note: foo)"
  const m = trimmed.match(/^(\S+?)(?:\s*\(([^)]*)\))?\s*$/);
  if (!m) {
    // Plain id
    return { targetId: trimmed, type: DEFAULT_EDGE_TYPE };
  }
  const targetId = m[1];
  const annotation = m[2];
  if (!annotation) return { targetId, type: DEFAULT_EDGE_TYPE };

  // Try single-word type (`task-abc (soft)`)
  const single = canonicalEdgeType(annotation);
  if (single) return { targetId, type: single };

  // Try key:value comma list (`task-abc (type: soft, note: ...)`) — robust to whitespace.
  const parts = annotation.split(',').map((s) => s.trim()).filter(Boolean);
  const edge = { targetId, type: DEFAULT_EDGE_TYPE };
  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx <= 0) {
      // Bare word inside kv group: treat as edge type if recognized.
      const t = canonicalEdgeType(part);
      if (t) edge.type = t;
      continue;
    }
    const key = part.slice(0, colonIdx).trim().toLowerCase();
    const value = part.slice(colonIdx + 1).trim();
    if (!value) continue;
    if (key === 'type') {
      const t = canonicalEdgeType(value);
      if (t) edge.type = t;
    } else if (key === 'except') {
      edge.except = value;
    } else if (key === 'note') {
      edge.note = value;
    }
  }
  return edge;
}

/**
 * Inverse of parseEdgeToken. Bare `targetId` when the edge is the default
 * hard-blocks with no optional fields; otherwise appends a `(...)` annotation.
 */
export function serializeEdgeToken(edge) {
  if (!edge || typeof edge.targetId !== 'string') return '';
  const parts = [];
  if (edge.type && edge.type !== DEFAULT_EDGE_TYPE) parts.push(edge.type);
  if (edge.except) parts.push(`except: ${edge.except}`);
  if (edge.note) parts.push(`note: ${edge.note}`);
  if (parts.length === 0) return edge.targetId;
  return `${edge.targetId} (${parts.join(', ')})`;
}
