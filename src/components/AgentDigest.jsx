/**
 * AgentDigest — Milestone 5 daily digest view.
 *
 * Reads `agent-log/YYYY-MM-DD.jsonl` for today + the last 7 days via the
 * injected `AgentDigestService`, then presents a per-day breakdown: op
 * counts by type, followed by the list of archived envelopes (coalesced
 * by opId so "queued → approved" shows as one final entry). Each entry
 * links to the tasks/sprints/projects it touched so the user can jump into
 * the planner context without leaving the view.
 *
 * Read-on-mount + manual refresh. New ops land in the log continuously;
 * clicking Refresh re-reads whatever has accumulated since the last load.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  RefreshCw, ScrollText, Check, X, Clock, AlertCircle,
  Plus, Pencil, Trash2, Package, CornerUpRight, Inbox,
} from 'lucide-react';
import useStore from '../store/useStore.js';

const STATUS_META = {
  applied:  { Icon: Check,      label: 'applied',  cls: 'text-accent-green border-accent-green/40 bg-accent-green/5' },
  queued:   { Icon: Clock,      label: 'queued',   cls: 'text-accent-amber border-accent-amber/40 bg-accent-amber/5' },
  rejected: { Icon: X,          label: 'rejected', cls: 'text-accent-red border-accent-red/40 bg-accent-red/5' },
  unknown:  { Icon: AlertCircle,label: 'unknown',  cls: 'text-accent-cream/50 border-accent-cream/20 bg-surface-1' },
};

const OP_ICON = {
  'task.add':      Plus,
  'task.update':   Pencil,
  'task.delete':   Trash2,
  'sprint.add':    Plus,
  'sprint.update': Pencil,
  'sprint.delete': Trash2,
  'project.add':   Plus,
  'project.update':Pencil,
  'project.delete':Trash2,
  'bulk':          Package,
  'unknown':       CornerUpRight,
};

function formatTime(ms) {
  if (!ms || typeof ms !== 'number') return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDayHeading(dateKey, nowDateKey) {
  if (dateKey === nowDateKey) return 'Today';
  try {
    const today = new Date(`${nowDateKey}T00:00:00Z`);
    const that  = new Date(`${dateKey}T00:00:00Z`);
    const diffDays = Math.round((today.getTime() - that.getTime()) / 86_400_000);
    if (diffDays === 1) return 'Yesterday';
    const weekday = that.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
    return `${weekday}`;
  } catch {
    return dateKey;
  }
}

function humanOpLabel(type) {
  if (!type) return 'Unknown';
  const map = {
    'task.add': 'Add task', 'task.update': 'Update task', 'task.delete': 'Delete task',
    'sprint.add': 'Add sprint', 'sprint.update': 'Update sprint', 'sprint.delete': 'Delete sprint',
    'project.add': 'Add project', 'project.update': 'Update project', 'project.delete': 'Delete project',
    'bulk': 'Bulk op',
  };
  return map[type] || type;
}

function EntityChip({ kind, id, lookup, onClick }) {
  const record = lookup(kind, id);
  const label = record?.name || record?.title || id;
  const color = kind === 'projects' ? record?.color : null;
  const Pill = (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 border border-accent-cream/15 text-accent-cream/70 hover:text-accent-cream hover:border-accent-cream/30 transition-all truncate max-w-[18rem]">
      {color && <span className="w-1.5 h-1.5 flex-shrink-0" style={{ background: color }} />}
      <span className="uppercase tracking-wider text-accent-cream/30">
        {kind === 'tasks' ? 'task' : kind === 'sprints' ? 'sprint' : 'proj'}
      </span>
      <span className="truncate">{label}</span>
      {!record && <span className="text-accent-cream/30 italic">(missing)</span>}
    </span>
  );
  if (!onClick) return Pill;
  return (
    <button
      type="button"
      onClick={() => onClick(kind, id, record)}
      className="text-left"
      title={record ? id : `${id} (no longer exists)`}
    >
      {Pill}
    </button>
  );
}

function EntryRow({ entry, lookup, onClickEntity }) {
  const meta = STATUS_META[entry.status] || STATUS_META.unknown;
  const OpIcon = OP_ICON[entry.type] || OP_ICON.unknown;
  const label = humanOpLabel(entry.type);
  const anyIds = entry.affected.projects.length + entry.affected.sprints.length + entry.affected.tasks.length;

  return (
    <li className={`border ${meta.cls} px-3 py-2`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <OpIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="font-mono text-[10px] uppercase tracking-wider flex-shrink-0">{label}</span>
          <span className="text-accent-cream/30 text-[10px]">·</span>
          <span className="text-accent-cream/50 text-[10px] font-mono truncate" title={entry.opId}>
            {entry.opId}
          </span>
          {entry.approvedFromQueue && (
            <span className="text-[9px] font-mono uppercase tracking-wider border border-accent-blue/40 text-accent-blue px-1.5 py-0.5">
              approved from queue
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] font-mono text-accent-cream/40">{formatTime(entry.timestamp)}</span>
          <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 border ${meta.cls}`}>
            <meta.Icon className="w-3 h-3 inline mr-1" />
            {meta.label}
          </span>
        </div>
      </div>

      {entry.reason && entry.status === 'queued' && (
        <div className="mt-1 text-[10px] text-accent-amber/70 font-mono">
          reason: {entry.reason === 'stale' ? 'snapshot stale' : entry.reason === 'trust' ? 'trust matrix' : entry.reason}
        </div>
      )}

      {entry.error && entry.status === 'rejected' && (
        <div className="mt-1 text-[10px] text-accent-red/80 font-mono">
          {entry.error.kind ? `${entry.error.kind}: ` : ''}{entry.error.message || 'unknown error'}
        </div>
      )}

      {entry.actor && (
        <div className="mt-1 text-[10px] text-accent-cream/30 font-mono">actor: {entry.actor}</div>
      )}

      {anyIds > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {entry.affected.projects.map((id) => (
            <EntityChip key={`p-${id}`} kind="projects" id={id} lookup={lookup} onClick={onClickEntity} />
          ))}
          {entry.affected.sprints.map((id) => (
            <EntityChip key={`s-${id}`} kind="sprints" id={id} lookup={lookup} onClick={onClickEntity} />
          ))}
          {entry.affected.tasks.map((id) => (
            <EntityChip key={`t-${id}`} kind="tasks" id={id} lookup={lookup} onClick={onClickEntity} />
          ))}
        </div>
      )}
    </li>
  );
}

function DayBlock({ day, lookup, onClickEntity, nowDateKey }) {
  const heading = formatDayHeading(day.dateKey, nowDateKey);
  const total = day.entries.length;
  const countChips = Object.entries(day.counts).sort((a, b) => b[1] - a[1]);

  return (
    <section className="space-y-2">
      <header className="flex items-baseline justify-between pb-1 border-b border-accent-amber/10">
        <div className="flex items-baseline gap-3">
          <h4 className="text-xs font-semibold text-accent-amber uppercase tracking-[0.2em] font-mono">{heading}</h4>
          <span className="text-[10px] text-accent-cream/30 font-mono">{day.dateKey}</span>
        </div>
        <span className="text-[10px] font-mono text-accent-cream/40">{total} op{total === 1 ? '' : 's'}</span>
      </header>

      {total === 0 ? (
        <div className="text-[10px] font-mono text-accent-cream/30 italic py-1">No agent activity on this day.</div>
      ) : (
        <>
          {countChips.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {countChips.map(([type, n]) => (
                <span key={type} className="text-[9px] font-mono uppercase tracking-wider border border-accent-cream/15 text-accent-cream/60 px-1.5 py-0.5">
                  {humanOpLabel(type)} × {n}
                </span>
              ))}
            </div>
          )}
          <ol className="space-y-1.5">
            {day.entries.map((entry) => (
              <EntryRow
                key={`${entry.opId}-${entry.timestamp}`}
                entry={entry}
                lookup={lookup}
                onClickEntity={onClickEntity}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export default function AgentDigest({ service, onTaskClick, onProjectClick }) {
  const projects = useStore((s) => s.projects);
  const sprints  = useStore((s) => s.sprints);
  const tasks    = useStore((s) => s.tasks);

  const [digest, setDigest] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const lookup = useCallback((kind, id) => {
    if (kind === 'tasks')    return tasks.find((t) => t.id === id);
    if (kind === 'sprints')  return sprints.find((s) => s.id === id);
    if (kind === 'projects') return projects.find((p) => p.id === id);
    return null;
  }, [tasks, sprints, projects]);

  const refresh = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    setError(null);
    try {
      const d = await service.loadDigest();
      setDigest(d);
    } catch (err) {
      setError(err?.message || String(err));
      setDigest([]);
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleEntityClick = useCallback((kind, id, record) => {
    if (!record) return;
    if (kind === 'tasks'    && typeof onTaskClick === 'function')    onTaskClick(record);
    else if (kind === 'projects' && typeof onProjectClick === 'function') onProjectClick(record.id);
  }, [onTaskClick, onProjectClick]);

  const nowDateKey = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const totalOps = useMemo(() => digest.reduce((n, d) => n + d.entries.length, 0), [digest]);

  return (
    <div className="p-5 space-y-4 max-w-4xl">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-8 h-8 bg-accent-amber/15 border border-accent-amber/30 flex items-center justify-center">
          <ScrollText className="w-4 h-4 text-accent-amber" />
        </div>
        <div className="flex-1">
          <h3 className="text-xs font-semibold text-accent-amber uppercase tracking-[0.2em] font-mono">Agent Digest</h3>
          <p className="text-[10px] text-accent-cream/30 font-mono">
            Everything Claude did over the last {digest.length || 8} days ({totalOps} op{totalOps === 1 ? '' : 's'})
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-accent-amber/20 text-accent-amber hover:bg-accent-amber/10 disabled:opacity-40 transition-all"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs font-mono border border-accent-red/40 text-accent-red bg-accent-red/5">
          Failed to load digest: {error}
        </div>
      )}

      {!loading && totalOps === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-12 text-accent-cream/40 space-y-2">
          <Inbox className="w-8 h-8 text-accent-cream/20" />
          <div className="text-xs font-mono">No agent activity in the last {digest.length || 8} days.</div>
          <div className="text-[10px] font-mono text-accent-cream/30 max-w-md text-center">
            Ops processed by the agent inbox watcher append to
            <code className="mx-1 px-1 border border-accent-cream/10 text-accent-amber/60">agent-log/YYYY-MM-DD.jsonl</code>
            and show up here once the first one is written.
          </div>
        </div>
      )}

      <div className="space-y-5">
        {digest.map((day) => (
          <DayBlock
            key={day.dateKey}
            day={day}
            lookup={lookup}
            onClickEntity={handleEntityClick}
            nowDateKey={nowDateKey}
          />
        ))}
      </div>
    </div>
  );
}
