import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { fmt, addDays, diffDays, today } from '../utils/dateUtils';
import { computeCriticalPath } from '../utils/criticalPath';
import { normalizeDep, DEFAULT_EDGE_TYPE } from '../utils/depEdges.js';
import useGanttGestures from '../hooks/useGanttGestures';
import useStore from '../store/useStore';
import { DndContext, useDraggable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import ContextMenu from './ContextMenu';

// Visual style per edge type. Keep in sync with the Milestone 3.5 design —
// hard is the solid default; soft is dashed; preempts is dashed-dotted red;
// deadline-independent is sparse-dotted muted.
const EDGE_STYLE = {
  'hard-blocks':          { dash: null,       widthDelta: 0,    colorIdle: 'rgba(212,168,67,0.30)', colorFaded: 'rgba(212,168,67,0.12)' },
  'soft-prefers':         { dash: '6 4',      widthDelta: -0.2, colorIdle: 'rgba(212,168,67,0.22)', colorFaded: 'rgba(212,168,67,0.08)' },
  'preempts':             { dash: '2 2 8 2',  widthDelta: 0.2,  colorIdle: 'rgba(239,68,68,0.55)',  colorFaded: 'rgba(239,68,68,0.20)' },
  'deadline-independent': { dash: '1 4',      widthDelta: -0.2, colorIdle: 'rgba(180,180,180,0.30)',colorFaded: 'rgba(180,180,180,0.10)' },
};

function DraggableBar({ task, project, dayWidth, ROW_H, startPx, barW, onTaskClick, onTaskContextMenu, isCritical, criticalActive }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: task.id,
    data: { task },
  });

  const isDone = task.status === 'done';

  const style = {
    left: startPx + (transform ? transform.x : 0),
    width: barW,
    height: ROW_H - 12,
    background: isDone ? '#6b7280' : project.color,
    borderLeft: `3px solid ${isDone ? '#4b5563' : project.color}`,
    opacity: isDone ? 0.45 : criticalActive ? (isCritical ? 1 : 0.3) : 0.85,
    ...(criticalActive && isCritical && !isDone ? { boxShadow: '0 0 8px rgba(239,68,68,0.5)', outline: '1.5px solid rgba(239,68,68,0.7)' } : {}),
  };

  return (
    <div
      ref={setNodeRef}
      className="absolute top-1.5 cursor-grab active:cursor-grabbing transition-shadow hover:opacity-100"
      style={style}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        if (!transform || (Math.abs(transform.x) < 3 && Math.abs(transform.y) < 3)) {
          onTaskClick(task);
        }
      }}
      onContextMenu={(e) => onTaskContextMenu?.(e, task)}
    >
      {barW > 60 && (
        <span className={`absolute inset-0 flex items-center px-2 text-[10px] font-mono font-medium truncate select-none uppercase tracking-wider ${isDone ? 'line-through text-white/50' : 'text-white/90'}`}>
          {task.title}
        </span>
      )}
    </div>
  );
}

const LABEL_COL_MIN = 140;
const LABEL_COL_MAX = 640;

export default function GanttChart({ tasks, sprints, projects, onTaskClick, onTaskDelete }) {
  const scrollRef = useRef(null);
  const labelScrollRef = useRef(null);
  const syncingScroll = useRef(false);
  const [zoom, setZoom] = useState('week');
  const [showCriticalPath, setShowCriticalPath] = useState(false);
  const [labelColWidth, setLabelColWidth] = useState(256);
  const dayWidth = zoom === 'day' ? 40 : zoom === 'week' ? 18 : 6;
  const ROW_H = 36;

  const onLabelResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = labelColWidth;

    const onMove = (ev) => {
      const next = Math.max(LABEL_COL_MIN, Math.min(LABEL_COL_MAX, startW + (ev.clientX - startX)));
      setLabelColWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [labelColWidth]);

  const updateTask = useStore((s) => s.updateTask);
  const deleteTaskStore = useStore((s) => s.deleteTask);

  const [contextMenu, setContextMenu] = useState(null);

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

  useGanttGestures(scrollRef, zoom, setZoom);

  const handleTimelineScroll = useCallback((e) => {
    if (syncingScroll.current) {
      syncingScroll.current = false;
      return;
    }
    const target = e.currentTarget;
    if (labelScrollRef.current && labelScrollRef.current.scrollTop !== target.scrollTop) {
      syncingScroll.current = true;
      labelScrollRef.current.scrollTop = target.scrollTop;
    }
  }, []);

  const handleLabelScroll = useCallback((e) => {
    if (syncingScroll.current) {
      syncingScroll.current = false;
      return;
    }
    const target = e.currentTarget;
    if (scrollRef.current && scrollRef.current.scrollTop !== target.scrollTop) {
      syncingScroll.current = true;
      scrollRef.current.scrollTop = target.scrollTop;
    }
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const projectMap = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects]
  );

  const sprintMap = useMemo(
    () => Object.fromEntries(sprints.map((s) => [s.id, s])),
    [sprints]
  );

  const { minDate, maxDate, totalDays } = useMemo(() => {
    const allDates = tasks.flatMap((t) => [t.startDate, t.endDate, t.dueDate].filter(Boolean));
    const sorted = [...allDates].sort();
    const min = sorted.length ? addDays(sorted[0], -3) : today;
    const max = sorted.length ? addDays(sorted[sorted.length - 1], 10) : addDays(today, 30);
    return { minDate: min, maxDate: max, totalDays: diffDays(min, max) };
  }, [tasks]);

  const dayColumns = useMemo(() => {
    const cols = [];
    for (let i = 0; i <= totalDays; i++) cols.push(addDays(minDate, i));
    return cols;
  }, [minDate, totalDays]);

  const grouped = useMemo(() => {
    const groups = [];
    projects.forEach((proj) => {
      const pSprints = sprints.filter((s) => s.projectId === proj.id);
      pSprints.forEach((sp) => {
        const sTasks = tasks.filter((t) => t.sprintId === sp.id);
        if (sTasks.length) groups.push({ project: proj, sprint: sp, tasks: sTasks });
      });
    });
    return groups;
  }, [tasks, sprints, projects]);

  const allRows = useMemo(() => {
    const rows = [];
    grouped.forEach((g) => {
      rows.push({ type: 'header', project: g.project, sprint: g.sprint });
      g.tasks.forEach((t) => rows.push({ type: 'task', task: t, project: g.project }));
    });
    return rows;
  }, [grouped]);

  const criticalTaskIds = useMemo(
    () => showCriticalPath ? computeCriticalPath(tasks) : new Set(),
    [tasks, showCriticalPath]
  );

  const todayOffset = diffDays(minDate, today);

  useEffect(() => {
    if (scrollRef.current) {
      const todayPx = todayOffset * dayWidth - scrollRef.current.clientWidth / 3;
      scrollRef.current.scrollLeft = Math.max(0, todayPx);
    }
  }, [todayOffset, dayWidth]);

  // Build a map of taskId -> row index (only task rows) for dependency arrows
  const taskRowMap = useMemo(() => {
    const map = {};
    let rowIdx = 0;
    allRows.forEach((row) => {
      if (row.type === 'header') {
        rowIdx++; // headers take space too
      } else {
        map[row.task.id] = rowIdx;
        rowIdx++;
      }
    });
    return map;
  }, [allRows]);

  // Compute dependency arrows
  const dependencyArrows = useMemo(() => {
    const arrows = [];
    const headerHeight = 28;

    allRows.forEach((row) => {
      if (row.type !== 'task') return;
      const deps = row.task.dependencies || [];
      if (deps.length === 0) return;

      for (const raw of deps) {
        const edge = normalizeDep(raw);
        if (!edge) continue;
        const depTask = tasks.find((t) => t.id === edge.targetId);
        if (!depTask) continue;

        const fromRowIdx = taskRowMap[depTask.id];
        const toRowIdx = taskRowMap[row.task.id];
        if (fromRowIdx === undefined || toRowIdx === undefined) continue;

        // Calculate pixel positions for "from" (end of dependency bar)
        const fromStart = diffDays(minDate, depTask.startDate);
        const fromDuration = diffDays(depTask.startDate, depTask.endDate);
        const fromBarEnd = (fromStart + fromDuration) * dayWidth;

        // Calculate "from" Y: accumulate row heights up to fromRowIdx
        let fromY = 0;
        let idx = 0;
        for (const r of allRows) {
          if (idx === fromRowIdx) break;
          fromY += r.type === 'header' ? headerHeight : ROW_H;
          idx++;
        }
        fromY += ROW_H / 2;

        // Calculate pixel positions for "to" (start of dependent bar)
        const toStart = diffDays(minDate, row.task.startDate);
        const toBarStart = toStart * dayWidth;

        // Calculate "to" Y
        let toY = 0;
        idx = 0;
        for (const r of allRows) {
          if (idx === toRowIdx) break;
          toY += r.type === 'header' ? headerHeight : ROW_H;
          idx++;
        }
        toY += ROW_H / 2;

        arrows.push({
          id: `${depTask.id}->${row.task.id}::${edge.type}`,
          fromTaskId: depTask.id,
          toTaskId: row.task.id,
          edgeType: edge.type,
          fromX: fromBarEnd,
          fromY,
          toX: toBarStart,
          toY,
        });
      }
    });

    return arrows;
  }, [allRows, tasks, taskRowMap, minDate, dayWidth, ROW_H]);

  const handleDragEnd = useCallback(
    (event) => {
      const { active, delta } = event;
      if (!delta || Math.abs(delta.x) < 3) return;

      const task = active.data.current?.task;
      if (!task) return;

      const dayOffset = Math.round(delta.x / dayWidth);
      if (dayOffset === 0) return;

      const newStart = addDays(task.startDate, dayOffset);
      const newEnd = addDays(task.endDate, dayOffset);
      const updates = { startDate: newStart, endDate: newEnd };
      if (task.dueDate) {
        updates.dueDate = addDays(task.dueDate, dayOffset);
      }
      updateTask(task.id, updates);
    },
    [dayWidth, updateTask]
  );

  // Compute total content height for the SVG overlay
  const totalContentHeight = useMemo(() => {
    return allRows.reduce((sum, r) => sum + (r.type === 'header' ? 28 : ROW_H), 0);
  }, [allRows, ROW_H]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-accent-amber/10 bg-surface-1/50">
        <span className="text-[10px] text-accent-amber/40 font-mono font-medium uppercase tracking-[0.2em] mr-2">Zoom</span>
        {['day', 'week', 'month'].map((z) => (
          <button
            key={z}
            onClick={() => setZoom(z)}
            className={`px-3 py-1 text-xs font-mono font-medium uppercase tracking-wider transition-all ${zoom === z ? 'bg-accent-amber/15 text-accent-amber border border-accent-amber/30' : 'text-accent-cream/30 hover:text-accent-cream/60 border border-transparent'}`}
          >
            {z}
          </button>
        ))}
        <div className="w-px h-5 bg-accent-amber/15 mx-1" />
        <button
          onClick={() => setShowCriticalPath((v) => !v)}
          className={`px-3 py-1 text-xs font-mono font-medium uppercase tracking-wider transition-all ${showCriticalPath ? 'bg-red-500/15 text-red-400 border border-red-500/30' : 'text-accent-cream/30 hover:text-accent-cream/60 border border-transparent'}`}
        >
          Critical Path
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Label column */}
        <div
          ref={labelScrollRef}
          onScroll={handleLabelScroll}
          className="relative flex-shrink-0 border-r border-accent-amber/10 overflow-y-auto"
          style={{ width: labelColWidth, minWidth: LABEL_COL_MIN, scrollbarWidth: 'none' }}
        >
          <div className="h-[52px] border-b border-accent-amber/10 flex items-end px-3 pb-2 bg-surface-1/30">
            <span className="text-[10px] text-accent-amber/30 uppercase tracking-[0.25em] font-semibold font-mono">Task</span>
          </div>
          {allRows.map((row, i) =>
            row.type === 'header' ? (
              <div
                key={`h-${i}`}
                className="h-[28px] flex items-center px-3 gap-2 bg-surface-2/30 border-b border-accent-amber/5"
                title={`${row.project.name} / ${row.sprint.name}`}
              >
                <div className="w-2 h-2 flex-shrink-0" style={{ background: row.project.color }} />
                <span className="text-[10px] text-accent-cream/40 font-semibold uppercase tracking-[0.2em] truncate font-mono">{row.sprint.name}</span>
              </div>
            ) : (
              <div
                key={row.task.id}
                className="flex items-center px-3 gap-2 cursor-pointer hover:bg-accent-amber/5 transition-colors border-b border-accent-amber/[0.03]"
                style={{ height: ROW_H }}
                onClick={() => onTaskClick(row.task)}
                onContextMenu={(e) => handleTaskContext(e, row.task)}
                title={row.task.title}
              >
                <span className={`text-xs truncate font-mono ${row.task.status === 'done' ? 'line-through text-accent-cream/30' : 'text-accent-cream/60'}`}>{row.task.title}</span>
              </div>
            )
          )}
          {/* Resize handle */}
          <div
            onMouseDown={onLabelResizeStart}
            className="absolute right-0 top-0 bottom-0 w-[6px] cursor-col-resize z-20 group"
            title="Drag to resize"
          >
            <div className="absolute right-0 top-0 bottom-0 w-px bg-accent-amber/10 group-hover:bg-accent-amber/40 transition-colors" />
          </div>
        </div>

        {/* Gantt timeline */}
        <div ref={scrollRef} onScroll={handleTimelineScroll} className="flex-1 overflow-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(180,160,100,0.15) transparent', touchAction: 'pan-x pan-y' }}>
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <div style={{ width: totalDays * dayWidth + 40, minWidth: '100%' }} className="relative">
              {/* Header */}
              <div className="sticky top-0 z-10 bg-surface-0/95 border-b border-accent-amber/10" style={{ height: 52 }}>
                <div className="relative h-full">
                  {dayColumns.map((d, i) => {
                    const dt = new Date(d);
                    const isMonday = dt.getDay() === 1;
                    const isFirst = i === 0 || dt.getDate() === 1;
                    return (
                      <div key={d} className="absolute top-0 h-full" style={{ left: i * dayWidth, width: dayWidth }}>
                        {(isFirst || (zoom !== 'month' && isMonday)) && (
                          <span className="absolute top-1 left-1 text-[9px] text-accent-amber/25 font-mono whitespace-nowrap uppercase">
                            {isFirst ? dt.toLocaleDateString('en-US', { month: 'short' }) + ' ' : ''}
                            {zoom !== 'month' ? dt.getDate() : ''}
                          </span>
                        )}
                        {d === today && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-accent-red/80" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Rows */}
              {allRows.map((row, i) =>
                row.type === 'header' ? (
                  <div key={`gh-${i}`} className="relative bg-surface-2/10" style={{ height: 28 }} />
                ) : (
                  <div key={row.task.id} className="relative group" style={{ height: ROW_H }}>
                    <div className="absolute inset-0 border-b border-accent-amber/[0.04]" />
                    <div className="absolute top-0 bottom-0" style={{ left: todayOffset * dayWidth, width: 1, background: 'rgba(192,57,43,0.3)' }} />
                    {(() => {
                      const start = diffDays(minDate, row.task.startDate);
                      const duration = diffDays(row.task.startDate, row.task.endDate);
                      const barW = Math.max(duration * dayWidth, 8);
                      return (
                        <DraggableBar
                          task={row.task}
                          project={row.project}
                          dayWidth={dayWidth}
                          ROW_H={ROW_H}
                          startPx={start * dayWidth}
                          barW={barW}
                          onTaskClick={onTaskClick}
                          onTaskContextMenu={handleTaskContext}
                          isCritical={criticalTaskIds.has(row.task.id)}
                          criticalActive={showCriticalPath}
                        />
                      );
                    })()}
                    {row.task.dueDate && (
                      <div
                        className="absolute top-1 w-0 h-0"
                        style={{
                          left: diffDays(minDate, row.task.dueDate) * dayWidth - 4,
                          borderLeft: '5px solid transparent',
                          borderRight: '5px solid transparent',
                          borderTop: `6px solid ${row.project.color}88`,
                        }}
                        title={`Due: ${row.task.dueDate}`}
                      />
                    )}
                  </div>
                )
              )}

              {/* Dependency arrows SVG overlay */}
              {dependencyArrows.length > 0 && (
                <svg
                  className="absolute top-[52px] left-0 pointer-events-none"
                  style={{ width: totalDays * dayWidth + 40, height: totalContentHeight }}
                >
                  <defs>
                    <marker
                      id="arrowhead"
                      markerWidth="8"
                      markerHeight="6"
                      refX="7"
                      refY="3"
                      orient="auto"
                    >
                      <polygon points="0 0, 8 3, 0 6" fill="rgba(212,168,67,0.5)" />
                    </marker>
                    <marker
                      id="arrowhead-critical"
                      markerWidth="8"
                      markerHeight="6"
                      refX="7"
                      refY="3"
                      orient="auto"
                    >
                      <polygon points="0 0, 8 3, 0 6" fill="rgba(239,68,68,0.8)" />
                    </marker>
                  </defs>
                  {dependencyArrows.map((arrow) => {
                    const midX = arrow.fromX + (arrow.toX - arrow.fromX) / 2;
                    const offsetX = Math.max(midX, arrow.fromX + 10);
                    const path =
                      `M ${arrow.fromX} ${arrow.fromY} ` +
                      `C ${offsetX} ${arrow.fromY}, ${offsetX} ${arrow.toY}, ${arrow.toX} ${arrow.toY}`;
                    // Only hard-blocks edges can be critical — soft/preempts/independent don't carry the path.
                    const isHard = arrow.edgeType === 'hard-blocks';
                    const isCriticalArrow = isHard && showCriticalPath
                      && criticalTaskIds.has(arrow.fromTaskId)
                      && criticalTaskIds.has(arrow.toTaskId);
                    const style = EDGE_STYLE[arrow.edgeType] || EDGE_STYLE[DEFAULT_EDGE_TYPE];
                    const stroke = isCriticalArrow
                      ? 'rgba(239,68,68,0.7)'
                      : (showCriticalPath ? style.colorFaded : style.colorIdle);
                    const width = (isCriticalArrow ? 2.5 : 1.5) + style.widthDelta;
                    return (
                      <path
                        key={arrow.id}
                        d={path}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={width}
                        strokeDasharray={style.dash || undefined}
                        markerEnd={isCriticalArrow ? 'url(#arrowhead-critical)' : 'url(#arrowhead)'}
                      >
                        <title>{arrow.edgeType}</title>
                      </path>
                    );
                  })}
                </svg>
              )}
            </div>
          </DndContext>
        </div>
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
