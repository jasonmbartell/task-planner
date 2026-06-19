import { useState, useMemo, useCallback, useRef, useEffect, Fragment } from 'react';
import useStore from '../store/useStore';
import { exportTasksCsv, downloadCsv, parseTasksCsv } from '../utils/csv';
import { downloadBackup } from '../utils/backup';
import CsvImportDialog from './CsvImportDialog';
import ContextMenu from './ContextMenu';

const STATUS_COLORS = {
  done: 'bg-accent-green',
  'in-progress': 'bg-accent-blue',
  blocked: 'bg-accent-red',
  todo: 'bg-accent-slate',
};

const ChevronIcon = ({ open }) => (
  <svg
    className={`w-3.5 h-3.5 transition-transform ${open ? '' : '-rotate-90'}`}
    fill="currentColor"
    viewBox="0 0 20 20"
  >
    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
  </svg>
);

const COLUMNS = [
  { key: 'title', label: 'Task', defaultWidth: 240, minWidth: 120 },
  { key: 'status', label: 'Status', defaultWidth: 120, minWidth: 80 },
  { key: 'startDate', label: 'Start', defaultWidth: 130, minWidth: 100 },
  { key: 'endDate', label: 'End', defaultWidth: 130, minWidth: 100 },
  { key: 'dueDate', label: 'Due', defaultWidth: 130, minWidth: 100 },
  { key: 'urgency', label: 'Urg', defaultWidth: 70, minWidth: 50 },
  { key: 'importance', label: 'Imp', defaultWidth: 70, minWidth: 50 },
  { key: 'difficulty', label: 'Diff', defaultWidth: 70, minWidth: 50 },
];

const ResizeHandle = ({ onMouseDown }) => (
  <div
    onMouseDown={onMouseDown}
    className="absolute right-0 top-0 bottom-0 w-[5px] cursor-col-resize z-20 group"
  >
    <div className="absolute right-[2px] top-1 bottom-1 w-px bg-accent-amber/10 group-hover:bg-accent-amber/40 transition-colors" />
  </div>
);

const ColumnHeaders = ({ sortBy, sortDir, onSort, colWidths, onResizeStart }) => (
  <tr className="border-b border-accent-amber/20 bg-surface-0/90">
    {COLUMNS.map((col, i) => (
      <th
        key={col.key}
        style={{ width: colWidths[i], minWidth: col.minWidth }}
        className="relative text-left px-3 py-1.5 text-[10px] font-semibold text-accent-amber/40 uppercase tracking-[0.2em] cursor-pointer hover:text-accent-amber/70 transition select-none font-mono"
      >
        <span onClick={() => onSort(col.key)}>
          {col.label}
          {sortBy === col.key && <span className="ml-1 opacity-50">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>}
        </span>
        <ResizeHandle onMouseDown={(e) => onResizeStart(e, i)} />
      </th>
    ))}
  </tr>
);

const EditableCell = ({ value, onChange, type = 'text', min, max, className = '' }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef(null);

  const startEdit = () => {
    setDraft(value);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commit = () => {
    setEditing(false);
    if (type === 'number') {
      const n = Math.min(max, Math.max(min, +draft || min));
      if (n !== value) onChange(n);
    } else {
      if (draft !== value) onChange(draft);
    }
  };

  if (!editing) {
    return (
      <span
        onClick={startEdit}
        className={`cursor-text hover:bg-accent-amber/[0.08] px-1 py-0.5 -mx-1 transition ${className}`}
      >
        {type === 'number' ? value : (value || '\u00A0')}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      type={type}
      value={draft}
      min={min}
      max={max}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
      className={`bg-surface-2 border border-accent-amber/30 outline-none px-1 py-0.5 -mx-1 text-accent-cream font-mono ${type === 'number' ? 'w-12 text-center' : 'w-full'} ${className}`}
      style={{ fontSize: 'inherit' }}
    />
  );
};

const TaskRow = ({ task, projColor, onTaskClick, onTaskContextMenu, updateTask, striped, onDragStart }) => (
  <tr
    className={`border-b border-accent-amber/[0.04] hover:bg-accent-amber/[0.05] transition-colors ${striped ? 'bg-accent-amber/[0.015]' : ''}`}
    draggable
    onDragStart={(e) => {
      e.dataTransfer.setData('text/plain', task.id);
      e.dataTransfer.effectAllowed = 'move';
      onDragStart?.(task.id);
    }}
    onContextMenu={(e) => onTaskContextMenu?.(e, task)}
  >
    <td className="px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 flex-shrink-0 rounded-sm cursor-grab" style={{ background: projColor || '#6b7f99' }} />
        <span
          onClick={() => onTaskClick?.(task)}
          className={`text-xs truncate font-mono cursor-pointer hover:text-accent-amber ${task.status === 'done' ? 'line-through text-accent-cream/30' : 'text-accent-cream/70'}`}
          title="Click to edit in modal"
        >
          {task.title || <span className="text-accent-cream/20 italic">(untitled)</span>}
        </span>
      </div>
    </td>
    <td className="px-3 py-2">
      <div className="flex items-center gap-1.5">
        <div className={`w-2 h-2 flex-shrink-0 ${STATUS_COLORS[task.status] || 'bg-accent-slate'}`} />
        <select
          value={task.status}
          onChange={(e) => updateTask(task.id, { status: e.target.value })}
          className="bg-transparent text-xs text-accent-cream/50 border-none outline-none cursor-pointer appearance-none font-mono uppercase"
        >
          {['todo', 'in-progress', 'done', 'blocked'].map((s) => (
            <option key={s} value={s} className="bg-surface-2">{s}</option>
          ))}
        </select>
      </div>
    </td>
    <td className="px-3 py-2">
      <input type="date" value={task.startDate || ''} onChange={(e) => updateTask(task.id, { startDate: e.target.value })} className="bg-transparent text-[11px] font-mono text-accent-cream/40 border-none outline-none w-full" style={{ colorScheme: 'dark' }} />
    </td>
    <td className="px-3 py-2">
      <input type="date" value={task.endDate || ''} onChange={(e) => updateTask(task.id, { endDate: e.target.value })} className="bg-transparent text-[11px] font-mono text-accent-cream/40 border-none outline-none w-full" style={{ colorScheme: 'dark' }} />
    </td>
    <td className="px-3 py-2">
      <input type="date" value={task.dueDate || ''} onChange={(e) => updateTask(task.id, { dueDate: e.target.value })} className="bg-transparent text-[11px] font-mono text-accent-cream/40 border-none outline-none w-full" style={{ colorScheme: 'dark' }} />
    </td>
    <td className="px-3 py-2 text-center text-xs font-mono">
      <EditableCell value={task.urgency} onChange={(v) => updateTask(task.id, { urgency: v })} type="number" min={1} max={10} className="text-xs font-mono font-semibold" />
    </td>
    <td className="px-3 py-2 text-center text-xs font-mono">
      <EditableCell value={task.importance} onChange={(v) => updateTask(task.id, { importance: v })} type="number" min={1} max={10} className="text-xs font-mono font-semibold" />
    </td>
    <td className="px-3 py-2 text-center text-xs font-mono">
      <EditableCell value={task.difficulty} onChange={(v) => updateTask(task.id, { difficulty: v })} type="number" min={1} max={10} className="text-xs font-mono font-semibold" />
    </td>
  </tr>
);

/* ── Inline Rename Input ── */
const InlineRename = ({ value, onCommit, onCancel, className = '' }) => {
  const [draft, setDraft] = useState(value);
  const ref = useRef(null);

  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onCancel(); }}
      onClick={(e) => e.stopPropagation()}
      className={`bg-surface-2 border border-accent-amber/30 outline-none px-1 py-0.5 font-mono ${className}`}
      style={{ fontSize: 'inherit' }}
    />
  );
};

/* ── New Sprint Inline Input ── */
const NewSprintInput = ({ projectId, onDone }) => {
  const addSprint = useStore((s) => s.addSprint);
  const [name, setName] = useState('');
  const ref = useRef(null);

  useEffect(() => { ref.current?.focus(); }, []);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed) {
      addSprint({ name: trimmed, projectId });
    }
    onDone();
  };

  return (
    <input
      ref={ref}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onDone(); }}
      onClick={(e) => e.stopPropagation()}
      placeholder="Sprint name..."
      className="bg-surface-2 border border-accent-amber/30 outline-none px-1.5 py-0.5 text-[11px] text-accent-cream/70 placeholder-accent-cream/20 font-mono w-40"
    />
  );
};

export default function SpreadsheetView({ tasks, sprints, projects, onTaskClick, onTaskDelete }) {
  const updateTask = useStore((s) => s.updateTask);
  const updateProject = useStore((s) => s.updateProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const updateSprint = useStore((s) => s.updateSprint);
  const deleteSprint = useStore((s) => s.deleteSprint);
  const deleteTaskAction = useStore((s) => s.deleteTask);

  const [sortBy, setSortBy] = useState('urgency');
  const [sortDir, setSortDir] = useState('asc');
  const [filter, setFilter] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [collapsedSprints, setCollapsedSprints] = useState({});
  const [colWidths, setColWidths] = useState(() => COLUMNS.map((c) => c.defaultWidth));

  // Context menu state
  const [contextMenu, setContextMenu] = useState(null);

  // Rename state
  const [renaming, setRenaming] = useState(null); // { type: 'project'|'sprint', id }

  // New sprint input state
  const [addingSprintFor, setAddingSprintFor] = useState(null); // projectId

  // CSV import state
  const [csvImport, setCsvImport] = useState(null); // { tasks, errors }
  const fileInputRef = useRef(null);

  // Drag state
  const [dragOverSprintId, setDragOverSprintId] = useState(null);
  const dragTaskId = useRef(null);

  const resizing = useRef(null);

  const onResizeStart = useCallback((e, colIndex) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[colIndex];

    const onMouseMove = (ev) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(COLUMNS[colIndex].minWidth, startWidth + delta);
      setColWidths((prev) => {
        const next = [...prev];
        next[colIndex] = newWidth;
        return next;
      });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizing.current = null;
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    resizing.current = colIndex;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [colWidths]);

  const sprintMap = useMemo(() => Object.fromEntries(sprints.map((s) => [s.id, s])), [sprints]);
  const projectMap = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);

  const toggleProject = (id) => setCollapsedProjects((prev) => ({ ...prev, [id]: !prev[id] }));
  const toggleSprint = (id) => setCollapsedSprints((prev) => ({ ...prev, [id]: !prev[id] }));

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };

  const sortTasks = (taskList) => {
    return [...taskList].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortBy === 'title') return dir * a.title.localeCompare(b.title);
      if (['startDate', 'endDate', 'dueDate'].includes(sortBy)) return dir * (a[sortBy] || '').localeCompare(b[sortBy] || '');
      return dir * ((a[sortBy] || 0) - (b[sortBy] || 0));
    });
  };

  // Drag handlers for sprint drop zones
  const handleDragOver = (e, sprintId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverSprintId(sprintId);
  };

  const handleDragLeave = () => {
    setDragOverSprintId(null);
  };

  const handleDrop = (e, sprintId) => {
    e.preventDefault();
    setDragOverSprintId(null);
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId && sprintId) {
      updateTask(taskId, { sprintId });
    }
    dragTaskId.current = null;
  };

  // Context menu handlers
  const handleProjectContext = (e, project) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Rename Project', action: () => setRenaming({ type: 'project', id: project.id }) },
        { separator: true },
        { label: 'Delete Project', action: () => deleteProject(project.id), danger: true },
      ],
    });
  };

  const handleSprintContext = (e, sprint) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Rename Sprint', action: () => setRenaming({ type: 'sprint', id: sprint.id }) },
        { separator: true },
        { label: 'Delete Sprint', action: () => deleteSprint(sprint.id), danger: true },
      ],
    });
  };

  const handleTaskContext = (e, task) => {
    e.preventDefault();
    e.stopPropagation();
    const doDelete = onTaskDelete || deleteTaskAction;
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
  };

  const handleExportCsv = () => {
    const csv = exportTasksCsv(tasks, projects, sprints);
    downloadCsv(csv, 'tasks.csv');
  };

  const handleExportBackup = () => {
    downloadBackup({ projects, sprints, tasks });
  };

  const handleImportFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { tasks: parsed, errors } = parseTasksCsv(ev.target.result);
      setCsvImport({ tasks: parsed, errors });
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const grouped = useMemo(() => {
    let filtered = tasks;
    if (filter) {
      const f = filter.toLowerCase();
      filtered = tasks.filter((t) => {
        const sp = sprintMap[t.sprintId];
        const proj = sp ? projectMap[sp.projectId] : null;
        return t.title.toLowerCase().includes(f) || proj?.name.toLowerCase().includes(f) || sp?.name.toLowerCase().includes(f);
      });
    }

    const result = { byProject: {}, uncategorized: [] };

    for (const task of filtered) {
      const sprint = sprintMap[task.sprintId];
      if (!sprint) {
        result.uncategorized.push(task);
        continue;
      }
      const projId = sprint.projectId;
      if (!result.byProject[projId]) result.byProject[projId] = {};
      if (!result.byProject[projId][sprint.id]) result.byProject[projId][sprint.id] = [];
      result.byProject[projId][sprint.id].push(task);
    }

    return result;
  }, [tasks, filter, sprintMap, projectMap]);

  const colCount = COLUMNS.length;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-accent-amber/10 bg-surface-1/50 flex items-center gap-2">
        <input
          type="text"
          placeholder="Filter tasks..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 bg-surface-2 border border-accent-amber/15 px-3 py-1.5 text-xs text-accent-cream placeholder-accent-cream/20 focus:outline-none focus:border-accent-amber/40 font-mono"
        />
        <button
          onClick={handleExportCsv}
          className="px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wider text-accent-amber/50 hover:text-accent-amber hover:bg-accent-amber/10 border border-accent-amber/15 transition whitespace-nowrap"
        >
          Export CSV
        </button>
        <button
          onClick={handleExportBackup}
          title="Download a full JSON backup of all projects, sprints, and tasks"
          className="px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wider text-accent-amber/50 hover:text-accent-amber hover:bg-accent-amber/10 border border-accent-amber/15 transition whitespace-nowrap"
        >
          Backup JSON
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wider text-accent-amber/50 hover:text-accent-amber hover:bg-accent-amber/10 border border-accent-amber/15 transition whitespace-nowrap"
        >
          Import CSV
        </button>
        <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImportFile} className="hidden" />
      </div>

      <div className="flex-1 overflow-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(180,160,100,0.15) transparent' }}>
        <table className="w-full min-w-[700px] border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            {colWidths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <tbody>
            {/* Projects with sprints */}
            {projects.map((project, projIdx) => {
              const projectSprints = grouped.byProject[project.id] || {};
              const isProjectCollapsed = collapsedProjects[project.id];
              const taskCount = Object.values(projectSprints).reduce((sum, t) => sum + t.length, 0);
              const allProjectSprints = sprints.filter((sp) => sp.projectId === project.id);

              // Always show the project header — empty projects need to be visible
              // so the user can add their first sprint via the "+ sprint" button.

              return (
                <Fragment key={project.id}>
                  {projIdx > 0 && (
                    <tr><td colSpan={colCount} className="h-2 bg-transparent" /></tr>
                  )}

                  {/* Project header */}
                  <tr
                    className="cursor-pointer select-none transition-colors"
                    style={{
                      background: `linear-gradient(90deg, ${project.color}18 0%, ${project.color}08 100%)`,
                      borderLeft: `3px solid ${project.color}`,
                    }}
                    onClick={() => toggleProject(project.id)}
                    onContextMenu={(e) => handleProjectContext(e, project)}
                  >
                    <td colSpan={colCount} className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <ChevronIcon open={!isProjectCollapsed} />
                        <div className="w-3 h-3 rounded-sm" style={{ background: project.color }} />
                        {renaming?.type === 'project' && renaming.id === project.id ? (
                          <InlineRename
                            value={project.name}
                            onCommit={(name) => { updateProject(project.id, { name }); setRenaming(null); }}
                            onCancel={() => setRenaming(null)}
                            className="text-sm font-semibold text-accent-cream/90 uppercase tracking-wider"
                          />
                        ) : (
                          <span className="text-sm font-semibold text-accent-cream/90 uppercase tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{project.name}</span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); setAddingSprintFor(addingSprintFor === project.id ? null : project.id); }}
                          className="ml-2 px-1.5 py-0.5 text-[10px] text-accent-amber/40 hover:text-accent-amber hover:bg-accent-amber/10 transition font-mono uppercase tracking-wider"
                          title="Add sprint"
                        >
                          + sprint
                        </button>
                        <span className="text-[10px] text-accent-cream/30 font-mono ml-auto mr-1">
                          {taskCount} task{taskCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </td>
                  </tr>

                  {/* New sprint input row */}
                  {addingSprintFor === project.id && (
                    <tr style={{ borderLeft: `3px solid ${project.color}40` }}>
                      <td colSpan={colCount} className="px-3 py-1.5 pl-9">
                        <div className="flex items-center gap-2">
                          <NewSprintInput projectId={project.id} onDone={() => setAddingSprintFor(null)} />
                        </div>
                      </td>
                    </tr>
                  )}

                  {!isProjectCollapsed && allProjectSprints.map((sprint) => {
                    const isSprintCollapsed = collapsedSprints[sprint.id];
                    const sprintTasks = sortTasks(projectSprints[sprint.id] || []);
                    const isDropTarget = dragOverSprintId === sprint.id;

                    return (
                      <Fragment key={sprint.id}>
                        {/* Sprint header — also a drop zone */}
                        <tr
                          className={`cursor-pointer select-none transition-colors hover:bg-accent-amber/[0.04] ${isDropTarget ? 'ring-1 ring-inset ring-accent-amber/50' : ''}`}
                          style={{
                            borderLeft: `3px solid ${project.color}40`,
                            background: isDropTarget ? 'rgba(180, 160, 100, 0.1)' : 'rgba(180, 160, 100, 0.03)',
                          }}
                          onClick={() => toggleSprint(sprint.id)}
                          onContextMenu={(e) => handleSprintContext(e, sprint)}
                          onDragOver={(e) => handleDragOver(e, sprint.id)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, sprint.id)}
                        >
                          <td colSpan={colCount} className="px-3 py-1.5 pl-9">
                            <div className="flex items-center gap-2">
                              <ChevronIcon open={!isSprintCollapsed} />
                              {renaming?.type === 'sprint' && renaming.id === sprint.id ? (
                                <InlineRename
                                  value={sprint.name}
                                  onCommit={(name) => { updateSprint(sprint.id, { name }); setRenaming(null); }}
                                  onCancel={() => setRenaming(null)}
                                  className="text-[11px] text-accent-cream/55 tracking-wide"
                                />
                              ) : (
                                <span className="text-[11px] text-accent-cream/55 font-mono tracking-wide">{sprint.name}</span>
                              )}
                              <span className="text-[10px] text-accent-cream/20 font-mono ml-auto mr-1">{sprintTasks.length} task{sprintTasks.length !== 1 ? 's' : ''}</span>
                            </div>
                          </td>
                        </tr>

                        {!isSprintCollapsed && (
                          <>
                            <ColumnHeaders sortBy={sortBy} sortDir={sortDir} onSort={handleSort} colWidths={colWidths} onResizeStart={onResizeStart} />
                            {sprintTasks.map((task, i) => (
                              <TaskRow
                                key={task.id}
                                task={task}
                                projColor={project.color}
                                onTaskClick={onTaskClick}
                                onTaskContextMenu={handleTaskContext}
                                updateTask={updateTask}
                                striped={i % 2 === 1}
                                onDragStart={(id) => { dragTaskId.current = id; }}
                              />
                            ))}
                            {sprintTasks.length === 0 && (
                              <tr
                                onDragOver={(e) => handleDragOver(e, sprint.id)}
                                onDragLeave={handleDragLeave}
                                onDrop={(e) => handleDrop(e, sprint.id)}
                              >
                                <td colSpan={colCount} className={`px-3 py-3 text-center text-[10px] text-accent-cream/20 font-mono italic ${isDropTarget ? 'bg-accent-amber/[0.08]' : ''}`}>
                                  Drop tasks here
                                </td>
                              </tr>
                            )}
                          </>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}

            {/* Uncategorized tasks */}
            {grouped.uncategorized.length > 0 && (
              <Fragment>
                {Object.keys(grouped.byProject).length > 0 && (
                  <tr><td colSpan={colCount} className="h-2 bg-transparent" /></tr>
                )}

                <tr
                  className="cursor-pointer select-none transition-colors hover:bg-accent-amber/[0.04]"
                  style={{
                    background: 'rgba(107, 127, 153, 0.08)',
                    borderLeft: '3px solid rgba(107, 127, 153, 0.3)',
                  }}
                  onClick={() => toggleProject('_uncategorized')}
                >
                  <td colSpan={colCount} className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <ChevronIcon open={!collapsedProjects['_uncategorized']} />
                      <div className="w-3 h-3 rounded-sm bg-accent-cream/15" />
                      <span className="text-sm font-semibold text-accent-cream/50 uppercase tracking-wider" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>Uncategorized</span>
                      <span className="text-[10px] text-accent-cream/25 font-mono ml-auto mr-1">{grouped.uncategorized.length} task{grouped.uncategorized.length !== 1 ? 's' : ''}</span>
                    </div>
                  </td>
                </tr>

                {!collapsedProjects['_uncategorized'] && (
                  <>
                    <ColumnHeaders sortBy={sortBy} sortDir={sortDir} onSort={handleSort} colWidths={colWidths} onResizeStart={onResizeStart} />
                    {sortTasks(grouped.uncategorized).map((task, i) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        projColor={null}
                        onTaskClick={onTaskClick}
                        onTaskContextMenu={handleTaskContext}
                        updateTask={updateTask}
                        striped={i % 2 === 1}
                        onDragStart={(id) => { dragTaskId.current = id; }}
                      />
                    ))}
                  </>
                )}
              </Fragment>
            )}
          </tbody>
        </table>
      </div>

      {/* CSV Import Dialog */}
      {csvImport && (
        <CsvImportDialog
          parsedTasks={csvImport.tasks}
          parseErrors={csvImport.errors}
          onClose={() => setCsvImport(null)}
        />
      )}

      {/* Context menu */}
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
