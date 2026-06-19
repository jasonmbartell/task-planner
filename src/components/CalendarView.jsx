import { useState, useMemo, useCallback } from 'react';
import { fmt, addDays, today, getMonday, getWeekDays, getMonthWeeks, isToday, isSameMonthAs } from '../utils/dateUtils';
import useStore from '../store/useStore';
import ContextMenu from './ContextMenu';

export default function CalendarView({ tasks, projects, sprints, onTaskClick, onTaskDelete }) {
  const [viewDate, setViewDate] = useState(new Date());
  const [mode, setMode] = useState('month');
  const [expandedDays, setExpandedDays] = useState({});
  const [contextMenu, setContextMenu] = useState(null);

  const deleteTaskStore = useStore((s) => s.deleteTask);

  const handleTaskContext = useCallback((e, task) => {
    e.preventDefault();
    e.stopPropagation();
    const doDelete = onTaskDelete || deleteTaskStore;
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Edit...', action: () => onTaskClick?.(task) },
        { separator: true },
        {
          label: 'Delete Task',
          action: () => {
            if (confirm(`Delete task "${task.title}"?`)) doDelete(task.id);
          },
          danger: true,
        },
      ],
    });
  }, [onTaskClick, onTaskDelete, deleteTaskStore]);

  const projectMap = Object.fromEntries(projects.map((p) => [p.id, p]));
  const sprintMap = Object.fromEntries(sprints.map((s) => [s.id, s]));
  const getColor = (task) => {
    const sprint = sprintMap[task.sprintId];
    if (!sprint) return '#6b7f99';
    const proj = projectMap[sprint.projectId];
    return proj ? proj.color : '#6b7f99';
  };

  const nav = (dir) => {
    const d = new Date(viewDate);
    if (mode === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setViewDate(d);
  };

  const weeks = useMemo(() => {
    if (mode === 'week') {
      return [getWeekDays(viewDate)];
    }
    return getMonthWeeks(viewDate);
  }, [viewDate, mode]);

  const tasksByDate = useMemo(() => {
    const map = {};
    tasks.forEach((t) => {
      const d = t.dueDate || t.endDate;
      if (!d) return;
      if (!map[d]) map[d] = [];
      map[d].push(t);
    });
    return map;
  }, [tasks]);

  const toggleExpand = (day) => {
    setExpandedDays((prev) => ({ ...prev, [day]: !prev[day] }));
  };

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const monthLabel = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-accent-amber/10 bg-surface-1/50">
        <div className="flex items-center gap-3">
          <button onClick={() => nav(-1)} className="p-1 hover:bg-accent-amber/10 transition text-accent-cream/40 hover:text-accent-amber font-mono text-lg">&#8249;</button>
          <h2 className="text-xs font-semibold text-accent-amber/70 min-w-[180px] text-center font-mono uppercase tracking-[0.2em]">{monthLabel}</h2>
          <button onClick={() => nav(1)} className="p-1 hover:bg-accent-amber/10 transition text-accent-cream/40 hover:text-accent-amber font-mono text-lg">&#8250;</button>
        </div>
        <div className="flex gap-1">
          {['week', 'month'].map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 text-xs font-mono font-medium uppercase tracking-wider transition-all ${mode === m ? 'bg-accent-amber/15 text-accent-amber border border-accent-amber/30' : 'text-accent-cream/30 hover:text-accent-cream/60 border border-transparent'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-accent-amber/10">
        {dayNames.map((d) => (
          <div key={d} className="py-2 text-center text-[10px] font-semibold text-accent-amber/30 uppercase tracking-[0.25em] font-mono">{d}</div>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b border-accent-amber/[0.05]" style={{ minHeight: mode === 'week' ? 200 : 100 }}>
            {week.map((day) => {
              const todayHighlight = isToday(day);
              const currentMonth = isSameMonthAs(day, viewDate);
              const dayTasks = tasksByDate[day] || [];
              const limit = mode === 'week' ? 8 : 3;
              const expanded = expandedDays[day];
              const visibleTasks = expanded ? dayTasks : dayTasks.slice(0, limit);
              const overflow = dayTasks.length - limit;
              return (
                <div key={day} className={`border-r border-accent-amber/[0.05] p-1 transition-colors ${todayHighlight ? 'bg-accent-red/5' : ''} ${!currentMonth && mode === 'month' ? 'opacity-30' : ''}`}>
                  <div className={`text-right mb-1 ${todayHighlight ? 'text-accent-red' : 'text-accent-cream/25'}`}>
                    <span className={`inline-flex items-center justify-center text-xs font-mono ${todayHighlight ? 'bg-accent-red/20 w-6 h-6' : ''}`}>
                      {new Date(day).getDate()}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {visibleTasks.map((t) => (
                      <div
                        key={t.id}
                        onClick={() => onTaskClick(t)}
                        onContextMenu={(e) => handleTaskContext(e, t)}
                        className="px-1.5 py-0.5 text-[10px] truncate cursor-pointer transition-all hover:opacity-80 font-mono"
                        style={{ background: getColor(t) + '22', color: getColor(t), borderLeft: `2px solid ${getColor(t)}` }}
                      >
                        {t.title}
                      </div>
                    ))}
                    {overflow > 0 && (
                      <button
                        onClick={() => toggleExpand(day)}
                        className="text-[9px] text-accent-amber/30 hover:text-accent-amber/60 px-1 cursor-pointer transition-colors font-mono uppercase"
                      >
                        {expanded ? 'show less' : `+${overflow} more`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
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
