/**
 * AgentInbox — Milestone 4 review surface.
 *
 * Lists every envelope sitting in `agent-archive/queued/` (fed by the AgentSync
 * apply path when the trust matrix / staleness check opted for "queue"). Each
 * card exposes Approve / Reject / Edit. Approve re-runs the envelope through
 * `_agentBulkApply` with `forceApply: true` and archives the outcome; Reject
 * archives the envelope with `error.kind: "user_rejected"`.
 *
 * The data comes from an `AgentInboxService` instance owned by `App.jsx` —
 * this component is a pure consumer via `useAgentInbox`.
 */

import { useMemo, useState } from 'react';
import { RefreshCw, Check, X, Pencil, AlertTriangle, Inbox as InboxIcon } from 'lucide-react';
import useAgentInbox from '../hooks/useAgentInbox';
import { EDGE_TYPES, canonicalEdgeType, DEFAULT_EDGE_TYPE } from '../utils/depEdges.js';
import AgentImport from './AgentImport.jsx';

const EDGE_BADGE_CLASS = {
  'hard-blocks':          'text-accent-red border-accent-red/40',
  'soft-prefers':         'text-accent-blue border-accent-blue/40',
  'preempts':             'text-accent-amber border-accent-amber/40',
  'deadline-independent': 'text-accent-cream/50 border-accent-cream/20',
};

function formatTimestamp(ms) {
  if (!ms || typeof ms !== 'number') return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function reasonLabel(reason) {
  if (reason === 'stale') return 'Stale snapshot — planner state changed after Claude read it.';
  if (reason === 'trust') return 'Trust matrix — this op type requires human approval.';
  if (!reason) return 'Queued for review.';
  return `Queued: ${reason}`;
}

function describeDep(edge) {
  if (typeof edge === 'string') {
    return { targetId: edge, type: DEFAULT_EDGE_TYPE };
  }
  if (!edge || typeof edge !== 'object') return null;
  const type = canonicalEdgeType(edge.type) || DEFAULT_EDGE_TYPE;
  return {
    targetId: edge.targetId || '?',
    type,
    note: edge.note || '',
    except: edge.except || '',
  };
}

function DepsList({ deps }) {
  if (!Array.isArray(deps) || deps.length === 0) return null;
  const normalized = deps.map(describeDep).filter(Boolean);
  if (normalized.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {normalized.map((d, i) => (
        <span
          key={`${d.targetId}-${i}`}
          className={`inline-flex items-center gap-1 text-[9px] uppercase tracking-wider border px-1.5 py-0.5 font-mono ${EDGE_BADGE_CLASS[d.type] || EDGE_BADGE_CLASS['hard-blocks']}`}
          title={d.note || d.except || d.type}
        >
          <span>{d.type}</span>
          <span className="opacity-70">→</span>
          <span className="normal-case tracking-normal">{d.targetId}</span>
        </span>
      ))}
    </div>
  );
}

function atomicOps(envelope) {
  if (!envelope) return [];
  if (envelope.type === 'bulk' && Array.isArray(envelope.payload?.ops)) {
    return envelope.payload.ops;
  }
  return [{ type: envelope.type, payload: envelope.payload }];
}

function summarizeOp(op) {
  if (!op || typeof op !== 'object') return { label: 'unknown', detail: '' };
  const t = op.type;
  const p = op.payload || {};
  switch (t) {
    case 'task.add': {
      const task = p.task || {};
      return {
        label: 'Add task',
        detail: task.title || task.id || '<untitled>',
        subdetail: task.sprintId ? `sprint: ${task.sprintId}` : '',
        deps: task.dependencies || [],
      };
    }
    case 'task.update': {
      const patch = p.patch || {};
      const keys = Object.keys(patch);
      return {
        label: 'Update task',
        detail: p.id || '<missing id>',
        subdetail: keys.length ? keys.map((k) => `${k}: ${stringifyPatchValue(patch[k])}`).join(' · ') : 'no fields',
        deps: patch.dependencies || null,
      };
    }
    case 'task.delete':
      return { label: 'Delete task', detail: p.id || '<missing id>', danger: true };
    case 'sprint.add':
      return { label: 'Add sprint', detail: p.sprint?.name || p.sprint?.id || '<untitled>', subdetail: p.sprint?.projectId ? `project: ${p.sprint.projectId}` : '' };
    case 'sprint.update':
      return { label: 'Update sprint', detail: p.id || '<missing id>', subdetail: summarizePatch(p.patch) };
    case 'sprint.delete':
      return { label: 'Delete sprint', detail: p.id || '<missing id>', danger: true, subdetail: 'cascades to tasks' };
    case 'project.add':
      return { label: 'Add project', detail: p.project?.name || p.project?.id || '<untitled>' };
    case 'project.update':
      return { label: 'Update project', detail: p.id || '<missing id>', subdetail: summarizePatch(p.patch) };
    case 'project.delete':
      return { label: 'Delete project', detail: p.id || '<missing id>', danger: true, subdetail: 'cascades to sprints + tasks' };
    default:
      return { label: t || 'unknown', detail: '' };
  }
}

function stringifyPatchValue(v) {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  return 'object';
}

function summarizePatch(patch) {
  if (!patch || typeof patch !== 'object') return '';
  const keys = Object.keys(patch);
  if (!keys.length) return 'no fields';
  return keys.map((k) => `${k}: ${stringifyPatchValue(patch[k])}`).join(' · ');
}

function isValidEdgeTypeName(t) {
  return EDGE_TYPES.includes(t);
}

function EditorModal({ item, onCancel, onSave }) {
  const [draft, setDraft] = useState(() => JSON.stringify(item.envelope, null, 2));
  const [err, setErr] = useState(null);

  const handleSave = () => {
    let parsed;
    try { parsed = JSON.parse(draft); }
    catch (e) { setErr(`Invalid JSON: ${e.message}`); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setErr('Envelope must be a JSON object.');
      return;
    }
    onSave(parsed);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-3xl max-h-[80vh] flex flex-col bg-surface-1 border border-accent-amber/30 shadow-xl shadow-black/60">
        <div className="flex items-center justify-between px-4 py-3 border-b border-accent-amber/10">
          <div>
            <h3 className="text-xs font-mono uppercase tracking-[0.2em] text-accent-amber">Edit envelope</h3>
            <p className="text-[10px] text-accent-cream/40 font-mono">{item.envelope?.opId || '<no opId>'}</p>
          </div>
          <button
            onClick={onCancel}
            className="text-accent-cream/50 hover:text-accent-cream"
            aria-label="Close editor"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <textarea
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setErr(null); }}
          className="flex-1 font-mono text-xs bg-surface-0 text-accent-cream/90 p-3 resize-none outline-none"
          spellCheck={false}
        />
        {err && (
          <div className="px-3 py-2 text-xs text-accent-red font-mono border-t border-accent-red/30 bg-accent-red/10">{err}</div>
        )}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-accent-amber/10">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-accent-green/40 text-accent-green hover:bg-accent-green/10 transition-all"
          >
            Save &amp; approve
          </button>
        </div>
      </div>
    </div>
  );
}

function QueuedCard({ item, onApprove, onReject, onEdit, pending }) {
  const ops = useMemo(() => atomicOps(item.envelope), [item.envelope]);
  const summaries = useMemo(() => ops.map(summarizeOp), [ops]);
  const isBulk = item.envelope?.type === 'bulk';
  const anyDanger = summaries.some((s) => s.danger);
  const unknownEdges = useMemo(() => {
    for (const op of ops) {
      const deps = op.payload?.task?.dependencies ?? op.payload?.patch?.dependencies;
      if (!Array.isArray(deps)) continue;
      for (const e of deps) {
        if (e && typeof e === 'object' && e.type && !isValidEdgeTypeName(canonicalEdgeType(e.type))) {
          return true;
        }
      }
    }
    return false;
  }, [ops]);

  return (
    <div className={`border bg-surface-1 ${anyDanger ? 'border-accent-red/30' : 'border-accent-amber/20'}`}>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-accent-amber/10">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
            <span className={anyDanger ? 'text-accent-red' : 'text-accent-amber'}>{isBulk ? `Bulk (${ops.length})` : ops[0]?.type || 'unknown'}</span>
            <span className="text-accent-cream/30">·</span>
            <span className="text-accent-cream/40 truncate" title={item.envelope?.opId}>{item.envelope?.opId || '<no opId>'}</span>
          </div>
          <div className="text-[10px] text-accent-cream/40 font-mono mt-0.5">
            queued {formatTimestamp(item.queuedAt)}
            {item.envelope?.actor ? <> · actor: {item.envelope.actor}</> : null}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            disabled={pending}
            className="flex items-center gap-1 px-2 py-1.5 min-h-[32px] text-[10px] font-mono uppercase tracking-wider border border-accent-cream/20 text-accent-cream/60 hover:text-accent-cream hover:border-accent-cream/40 disabled:opacity-40 transition-all"
            title="Edit envelope JSON before approving"
          >
            <Pencil className="w-3 h-3" />
            <span className="hidden sm:inline">Edit</span>
          </button>
          <button
            onClick={onReject}
            disabled={pending}
            className="flex items-center gap-1 px-2 py-1.5 min-h-[32px] text-[10px] font-mono uppercase tracking-wider border border-accent-red/40 text-accent-red hover:bg-accent-red/10 disabled:opacity-40 transition-all"
          >
            <X className="w-3 h-3" />
            <span className="hidden sm:inline">Reject</span>
          </button>
          <button
            onClick={onApprove}
            disabled={pending}
            className="flex items-center gap-1 px-2 py-1.5 min-h-[32px] text-[10px] font-mono uppercase tracking-wider border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-40 transition-all"
          >
            <Check className="w-3 h-3" />
            <span className="hidden sm:inline">Approve</span>
          </button>
        </div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 text-[10px] text-accent-cream/50 font-mono">
          <AlertTriangle className="w-3 h-3 text-accent-amber/60" />
          <span>{reasonLabel(item.reason)}</span>
        </div>
        {unknownEdges && (
          <div className="text-[10px] text-accent-red font-mono">
            Warning: envelope contains an unknown dependency edge type — approving as-is will fail validation.
          </div>
        )}
        <ol className="space-y-1.5">
          {summaries.map((s, i) => (
            <li key={i} className="text-xs">
              <div className="flex items-baseline gap-2">
                <span className={`font-mono text-[10px] uppercase tracking-wider ${s.danger ? 'text-accent-red' : 'text-accent-amber/80'}`}>{s.label}</span>
                <span className="text-accent-cream/80 truncate" title={s.detail}>{s.detail}</span>
              </div>
              {s.subdetail && <div className="text-[10px] text-accent-cream/40 font-mono mt-0.5 truncate">{s.subdetail}</div>}
              {Array.isArray(s.deps) && s.deps.length > 0 && <DepsList deps={s.deps} />}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default function AgentInbox({ service, store }) {
  const { queued, approve, reject, refresh } = useAgentInbox(service);
  const [pendingPath, setPendingPath] = useState(null);
  const [editing, setEditing] = useState(null);
  const [banner, setBanner] = useState(null);

  const handleApprove = async (item, edited) => {
    setPendingPath(item.absPath);
    setBanner(null);
    try {
      const res = await approve(item.absPath, edited);
      if (res?.status === 'applied') {
        setBanner({ tone: 'ok', text: `Approved: ${item.envelope?.opId} (${res.status})` });
      } else if (res?.status === 'rejected') {
        setBanner({ tone: 'err', text: `Approval rejected: ${res.error?.message || res.error?.kind || 'unknown'}` });
      } else {
        setBanner({ tone: 'warn', text: `Approval result: ${res?.status || 'unknown'}` });
      }
    } catch (err) {
      setBanner({ tone: 'err', text: `Approve failed: ${err.message || err}` });
    } finally {
      setPendingPath(null);
    }
  };

  const handleReject = async (item) => {
    setPendingPath(item.absPath);
    setBanner(null);
    try {
      await reject(item.absPath);
      setBanner({ tone: 'ok', text: `Rejected: ${item.envelope?.opId}` });
    } catch (err) {
      setBanner({ tone: 'err', text: `Reject failed: ${err.message || err}` });
    } finally {
      setPendingPath(null);
    }
  };

  const handleEditSave = async (edited) => {
    const item = editing;
    setEditing(null);
    if (item) await handleApprove(item, edited);
  };

  return (
    <div className="p-5 space-y-4 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-8 h-8 bg-accent-amber/15 border border-accent-amber/30 flex items-center justify-center">
          <InboxIcon className="w-4 h-4 text-accent-amber" />
        </div>
        <div className="flex-1">
          <h3 className="text-xs font-semibold text-accent-amber uppercase tracking-[0.2em] font-mono">Agent Inbox</h3>
          <p className="text-[10px] text-accent-cream/30 font-mono">Queued ops waiting on your review ({queued.length})</p>
        </div>
        <button
          onClick={() => refresh()}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-accent-amber/20 text-accent-amber hover:bg-accent-amber/10 transition-all"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {banner && (
        <div className={`px-3 py-2 text-xs font-mono border ${
          banner.tone === 'ok'  ? 'border-accent-green/40 text-accent-green bg-accent-green/5' :
          banner.tone === 'err' ? 'border-accent-red/40 text-accent-red bg-accent-red/5' :
                                  'border-accent-amber/40 text-accent-amber bg-accent-amber/5'
        }`}>
          {banner.text}
        </div>
      )}

      {store && (
        <AgentImport
          store={store}
          onAfterRun={() => { refresh(); }}
        />
      )}

      {queued.length === 0 ? (
        <div className="text-center py-12 text-accent-cream/40 text-xs font-mono">
          Nothing queued. Agent ops that need review will appear here.
        </div>
      ) : (
        <div className="space-y-3">
          {queued.map((item) => (
            <QueuedCard
              key={item.absPath}
              item={item}
              pending={pendingPath === item.absPath}
              onApprove={() => handleApprove(item)}
              onReject={() => handleReject(item)}
              onEdit={() => setEditing(item)}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditorModal
          item={editing}
          onCancel={() => setEditing(null)}
          onSave={handleEditSave}
        />
      )}
    </div>
  );
}
