import { useCallback, useRef, useState } from 'react';
import GanttChart from './GanttChart';
import SpreadsheetView from './SpreadsheetView';
import SprintVelocity from './SprintVelocity';
import useStore from '../store/useStore';

const MIN_PANE_PCT = 4;

/**
 * Project dashboard split into three vertically resizable panes:
 * Gantt (top) / Spreadsheet (middle) / Sprint velocity (bottom).
 *
 * Two drag handles redistribute height between adjacent panes. Sizes are
 * stored as percentages so the layout reflows when the window resizes.
 */
export default function ProjectDashboard({
  project,
  tasks,
  sprints,
  onTaskClick,
  onTaskDelete,
}) {
  const containerRef = useRef(null);
  // Boundary positions as percentages from the top of the container.
  // Defaults: ~48% Gantt + ~47% Spreadsheet + ~5% Velocity. Velocity starts collapsed
  // to just its toolbar; drag the lower handle up to expose the chart and table.
  const [topPct, setTopPct] = useState(48);
  const [midBottomPct, setMidBottomPct] = useState(95);

  const addSprint = useStore((s) => s.addSprint);
  const [addingSprint, setAddingSprint] = useState(false);
  const [newSprintName, setNewSprintName] = useState('');
  const newSprintInputRef = useRef(null);

  const startAddSprint = () => {
    setAddingSprint(true);
    setNewSprintName('');
    setTimeout(() => newSprintInputRef.current?.focus(), 0);
  };

  const commitNewSprint = () => {
    const trimmed = newSprintName.trim();
    if (trimmed) {
      addSprint({ name: trimmed, projectId: project.id });
    }
    setAddingSprint(false);
    setNewSprintName('');
  };

  const cancelNewSprint = () => {
    setAddingSprint(false);
    setNewSprintName('');
  };

  const startResize = useCallback((which) => (e) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const onMove = (ev) => {
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      if (which === 'top') {
        const next = Math.max(MIN_PANE_PCT, Math.min(midBottomPct - MIN_PANE_PCT, pct));
        setTopPct(next);
      } else {
        const next = Math.max(topPct + MIN_PANE_PCT, Math.min(100 - MIN_PANE_PCT, pct));
        setMidBottomPct(next);
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [topPct, midBottomPct]);

  const topH = `${topPct}%`;
  const midH = `${midBottomPct - topPct}%`;
  const bottomH = `${100 - midBottomPct}%`;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-1.5 border-b border-accent-amber/10 bg-surface-1/50 flex items-center gap-2 flex-shrink-0">
        {addingSprint ? (
          <>
            <input
              ref={newSprintInputRef}
              type="text"
              value={newSprintName}
              onChange={(e) => setNewSprintName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitNewSprint(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancelNewSprint(); }
              }}
              placeholder="Sprint name..."
              className="bg-surface-2 border border-accent-amber/30 outline-none px-2 py-1 text-[11px] text-accent-cream placeholder-accent-cream/30 font-mono w-56"
            />
            <button
              type="button"
              onClick={commitNewSprint}
              className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-accent-amber/70 hover:text-accent-amber border border-accent-amber/20 hover:border-accent-amber/40 hover:bg-accent-amber/10 transition"
            >
              Add
            </button>
            <button
              type="button"
              onClick={cancelNewSprint}
              className="px-1.5 py-1 text-[11px] font-mono text-accent-cream/40 hover:text-accent-cream/70 transition"
              aria-label="Cancel"
              title="Cancel"
            >
              &#x2715;
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={startAddSprint}
            className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-accent-amber/60 hover:text-accent-amber hover:bg-accent-amber/10 border border-accent-amber/15 hover:border-accent-amber/40 transition"
            title="Add a new sprint to this project"
          >
            + New Sprint
          </button>
        )}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
      <div style={{ height: topH }} className="min-h-0 overflow-hidden">
        <GanttChart
          tasks={tasks}
          sprints={sprints}
          projects={[project]}
          onTaskClick={onTaskClick}
          onTaskDelete={onTaskDelete}
        />
      </div>

      <div
        onMouseDown={startResize('top')}
        className="h-[6px] flex-shrink-0 cursor-row-resize bg-accent-amber/15 hover:bg-accent-amber/40 transition-colors relative group"
        title="Drag to resize"
      >
        <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 w-8 h-px bg-accent-amber/40 group-hover:bg-accent-amber/70" />
      </div>

      <div style={{ height: midH }} className="min-h-0 overflow-hidden">
        <SpreadsheetView
          tasks={tasks}
          sprints={sprints}
          projects={[project]}
          onTaskClick={onTaskClick}
          onTaskDelete={onTaskDelete}
        />
      </div>

      <div
        onMouseDown={startResize('mid')}
        className="h-[6px] flex-shrink-0 cursor-row-resize bg-accent-amber/15 hover:bg-accent-amber/40 transition-colors relative group"
        title="Drag to resize"
      >
        <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 w-8 h-px bg-accent-amber/40 group-hover:bg-accent-amber/70" />
      </div>

      <div style={{ height: bottomH }} className="min-h-0 overflow-hidden">
        <SprintVelocity projectId={project.id} />
      </div>
      </div>
    </div>
  );
}
