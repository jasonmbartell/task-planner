import { useMemo, useCallback, useState } from 'react';
import { CalendarClock, AlertTriangle, CalendarDays } from 'lucide-react';
import useStore from '../store/useStore';
import { today, addDays, fmtFull, fmtShort } from '../utils/dateUtils';
import ContextMenu from './ContextMenu';

const STATUS_COLORS = {
  done: 'bg-accent-green',
  'in-progress': 'bg-accent-blue',
  blocked: 'bg-accent-red',
  todo: 'bg-accent-slate',
};

/**
 * Daily agenda — P1d thin surface. Three buckets:
 *   - Today: due on or before today and not done
 *   - This Week: due in (today, today+7]
 *   - At Risk: not done, no due date, but starts in the past or has slipped
 *
 * Sorts within each bucket by dueDate asc, then urgency desc.
 */
export default function AgendaView({ tasks, sprints, projects, onTaskClick, onTaskDelete }) {
  const updateTask = useStore((s) => s.updateTask);
  const deleteTaskStore = useStore((s) => s.deleteTask);
  const [contextMenu, setContextMenu] = useState(null);

  const sprintMap = useMemo(() => Object.fromEntries(sprints.map((s) => [s.id, s])), [sprints]);
  const projectMap = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);

  const projectFor = useCallback((task) => {
    const sp = sprintMap[task.sprintId];
    if (!sp) return null;
    return projectMap[sp.projectId] || null;
  }, [sprintMap, projectMap]);

  const buckets = useMemo(() => {
    const weekEnd = addDays(today, 7);
    const todayBucket = [];
    const weekBucket = [];
    const riskBucket = [];

    for (const t of tasks) {
      if (t.status === 'done') continue;
      const due = t.dueDate;
      if (due && due <= today) {
        todayBucket.push(t);
      } else if (due && due > today && due <= weekEnd) {
        weekBucket.push(t);
      } else if (
        t.status === 'blocked' ||
        (t.startDate && t.startDate <= today && (!due || due > weekEnd))
      ) {
        riskBucket.push(t);
      }
    }

    const sortFn = (a, b) => {
      const ad = a.dueDate || '9999-12-31';
      const bd = b.dueDate || '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return (b.urgency || 0) - (a.urgency || 0);
    };
    todayBucket.sort(sortFn);
    weekBucket.sort(sortFn);
    riskBucket.sort(sortFn);

    return { todayBucket, weekBucket, riskBucket };
  }, [tasks]);

  const handleContext = useCallback((e, task) => {
    e.preventDefault();
    e.stopPropagation();
    const doDelete = onTaskDelete || deleteTaskStore;
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Edit...', action: () => onTaskClick?.(task) },
        { separator: true },
        { label: 'Mark Done', action: () => updateTask(task.id, { status: 'done' }) },
        { separator: true },
        {
          label: 'Delete Task',
          action: () => { if (confirm(`Delete task "${task.title}"?`)) doDelete(task.id); },
          danger: true,
        },
      ],
    });
  }, [onTaskClick, onTaskDelete, deleteTaskStore, updateTask]);

  const renderTaskRow = (task) => {
    const project = projectFor(task);
    const isOverdue = task.dueDate && task.dueDate < today;
    return (
      <button
        key={task.id}
        type="button"
        onClick={() => onTaskClick?.(task)}
        onContextMenu={(e) => handleContext(e, task)}
        className="w-full flex items-center gap-3 px-4 py-2.5 border-b border-accent-amber/[0.05] hover:bg-accent-amber/[0.05] transition-colors text-left group"
        title={task.title}
      >
        <div
          className="w-2.5 h-2.5 flex-shrink-0 rounded-sm"
          style={{ background: project?.color || '#6b7f99' }}
          title={project?.name || 'No project'}
        />
        <div className={`w-2 h-2 flex-shrink-0 ${STATUS_COLORS[task.status] || STATUS_COLORS.todo}`} />
        <span className="flex-1 min-w-0 text-xs font-mono text-accent-cream/80 truncate">
          {task.title}
        </span>
        {project && (
          <span className="text-[10px] font-mono text-accent-cream/30 truncate max-w-[140px] hidden sm:inline">
            {project.name}
          </span>
        )}
        <span className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider w-16 justify-end">
          <span className="text-accent-cream/30">U</span>
          <span className="text-accent-cream/60">{task.urgency ?? '-'}</span>
        </span>
        <span
          className={`text-[10px] font-mono w-24 text-right ${
            isOverdue ? 'text-accent-red' : 'text-accent-cream/40'
          }`}
        >
          {task.dueDate ? fmtShort(task.dueDate) : '—'}
        </span>
      </button>
    );
  };

  const Section = ({ icon: Icon, title, accent, count, children, empty }) => (
    <section className="border-b border-accent-amber/10">
      <header className="px-4 py-2.5 flex items-center gap-2 bg-surface-1/40 sticky top-0 z-10">
        <Icon className={`w-3.5 h-3.5 ${accent}`} />
        <span className="text-[10px] font-mono uppercase tracking-[0.25em] font-semibold text-accent-cream/70">
          {title}
        </span>
        <span className="text-[10px] font-mono text-accent-cream/30">({count})</span>
      </header>
      {count === 0 ? (
        <div className="px-4 py-4 text-[11px] font-mono italic text-accent-cream/25">{empty}</div>
      ) : (
        children
      )}
    </section>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-accent-amber/10 bg-surface-1/50 flex items-baseline gap-3">
        <h2 className="text-[11px] font-mono uppercase tracking-[0.25em] font-semibold text-accent-amber/70">
          Agenda
        </h2>
        <span className="text-[10px] font-mono text-accent-cream/40">{fmtFull(today)}</span>
      </div>
      <div
        className="flex-1 overflow-auto"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(180,160,100,0.15) transparent' }}
      >
        <Section
          icon={CalendarClock}
          title="Today"
          accent="text-accent-red"
          count={buckets.todayBucket.length}
          empty="Nothing due today. Take a breath."
        >
          {buckets.todayBucket.map(renderTaskRow)}
        </Section>
        <Section
          icon={CalendarDays}
          title="This Week"
          accent="text-accent-amber"
          count={buckets.weekBucket.length}
          empty="No deadlines in the next 7 days."
        >
          {buckets.weekBucket.map(renderTaskRow)}
        </Section>
        <Section
          icon={AlertTriangle}
          title="At Risk"
          accent="text-accent-red/70"
          count={buckets.riskBucket.length}
          empty="No work in progress past its start date."
        >
          {buckets.riskBucket.map(renderTaskRow)}
        </Section>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
