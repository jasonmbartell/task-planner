import { useState, useMemo, useCallback, useRef } from 'react';
import { EDGE_TYPES, DEFAULT_EDGE_TYPE, normalizeDeps } from '../utils/depEdges.js';
import { genId } from '../utils/ids.js';
import useStore from '../store/useStore';

const NEW_SPRINT_SENTINEL = '__new__';

const EDGE_TYPE_LABELS = {
  'hard-blocks': 'Hard blocker',
  'soft-prefers': 'Soft preference',
  'preempts': 'Preempts',
  'deadline-independent': 'Deadline-independent',
};

const Field = ({ label, error, children }) => (
  <div className="space-y-1">
    <label className="text-[10px] font-semibold text-accent-amber/40 uppercase tracking-[0.2em] font-mono">{label}</label>
    {children}
    {error && <p className="text-[10px] text-accent-red font-mono">{error}</p>}
  </div>
);

export default function TaskModal({ task, onClose, onSave, onDelete, sprints, projects, tasks: allTasks }) {
  // For new tasks, derive initial project from the sprint
  const initialProjectId = useMemo(() => {
    if (task.id) return null; // existing task — no project selector
    const sprint = sprints.find((s) => s.id === task.sprintId);
    return sprint?.projectId || projects[0]?.id || '';
  }, []);

  const [form, setForm] = useState({
    ...task,
    description: task.description || '',
    dependencies: normalizeDeps(
      task.dependencies || (task.dependency ? [task.dependency] : []),
    ),
  });
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [touched, setTouched] = useState({});
  const [panelWidth, setPanelWidth] = useState(420);
  const resizing = useRef(null);

  // Inline "new sprint" creation from the Sprint dropdown
  const addSprint = useStore((s) => s.addSprint);
  const [newSprintName, setNewSprintName] = useState('');
  const [creatingSprint, setCreatingSprint] = useState(false);
  const newSprintInputRef = useRef(null);

  // Dependency picker state
  const [depQuery, setDepQuery] = useState('');
  const [depFocused, setDepFocused] = useState(false);
  const [depHighlight, setDepHighlight] = useState(0);
  const depBlurTimer = useRef(null);

  // Lookups for rendering task breadcrumbs in chips / dropdown
  const sprintMap = useMemo(() => Object.fromEntries(sprints.map((s) => [s.id, s])), [sprints]);
  const projectMap = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);
  const taskMap = useMemo(() => Object.fromEntries(allTasks.map((t) => [t.id, t])), [allTasks]);

  const taskBreadcrumb = (t) => {
    if (!t) return '';
    const sp = sprintMap[t.sprintId];
    const pr = sp ? projectMap[sp.projectId] : null;
    if (pr && sp) return `${pr.name} / ${sp.name}`;
    if (sp) return sp.name;
    return '';
  };

  const depSuggestions = useMemo(() => {
    const selectedIds = new Set((form.dependencies || []).map((d) => d.targetId));
    const q = depQuery.trim().toLowerCase();
    const candidates = allTasks.filter((t) => t.id !== form.id && !selectedIds.has(t.id));
    const matches = q
      ? candidates.filter((t) => (t.title || '').toLowerCase().includes(q))
      : [...candidates].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return matches.slice(0, 10);
  }, [allTasks, form.id, form.dependencies, depQuery]);

  const addDependency = (targetId) => {
    const deps = form.dependencies || [];
    if (!targetId || deps.some((d) => d.targetId === targetId)) return;
    set('dependencies', [...deps, { targetId, type: DEFAULT_EDGE_TYPE }]);
    setDepQuery('');
    setDepHighlight(0);
  };

  const removeDependency = (targetId) => {
    const deps = form.dependencies || [];
    set('dependencies', deps.filter((d) => d.targetId !== targetId));
  };

  const changeDependencyType = (targetId, type) => {
    const deps = form.dependencies || [];
    set('dependencies', deps.map((d) => (d.targetId === targetId ? { ...d, type } : d)));
  };

  const onDepKeyDown = (e) => {
    if (depSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setDepHighlight((i) => Math.min(depSuggestions.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setDepHighlight((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = depSuggestions[Math.min(depHighlight, depSuggestions.length - 1)];
      if (pick) addDependency(pick.id);
    } else if (e.key === 'Escape') {
      setDepQuery('');
      setDepFocused(false);
    }
  };

  const isNew = !task.id;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const touch = (k) => setTouched((t) => ({ ...t, [k]: true }));

  // Sprints filtered by selected project (only for new tasks)
  const filteredSprints = useMemo(() => {
    if (!isNew) return sprints;
    if (!selectedProjectId) return sprints;
    return sprints.filter((s) => s.projectId === selectedProjectId);
  }, [isNew, selectedProjectId, sprints]);

  // When project changes, auto-select first sprint of that project
  const handleProjectChange = (projId) => {
    setSelectedProjectId(projId);
    setCreatingSprint(false);
    const projSprints = sprints.filter((s) => s.projectId === projId);
    if (projSprints.length > 0) {
      set('sprintId', projSprints[0].id);
    } else {
      set('sprintId', '');
    }
  };

  const handleSprintSelectChange = (val) => {
    if (val === NEW_SPRINT_SENTINEL) {
      setCreatingSprint(true);
      setNewSprintName('');
      setTimeout(() => newSprintInputRef.current?.focus(), 0);
      return;
    }
    set('sprintId', val);
  };

  const commitNewSprint = () => {
    const trimmed = newSprintName.trim();
    if (!trimmed || !selectedProjectId) {
      cancelNewSprint();
      return;
    }
    const id = genId('sprint');
    addSprint({ id, name: trimmed, projectId: selectedProjectId });
    set('sprintId', id);
    setCreatingSprint(false);
    setNewSprintName('');
  };

  const cancelNewSprint = () => {
    setCreatingSprint(false);
    setNewSprintName('');
  };

  const errors = useMemo(() => {
    const e = {};
    if (!form.title || !form.title.trim()) e.title = 'Title is required.';
    // Date ordering is auto-enforced on save (see utils/dateEnforcement.js):
    // startDate past dueDate snaps end+due forward; end always equals due.
    return e;
  }, [form.title]);

  const hasErrors = Object.keys(errors).length > 0;

  const onResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;

    const onMouseMove = (ev) => {
      const delta = startX - ev.clientX;
      setPanelWidth(Math.max(320, Math.min(800, startWidth + delta)));
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
    resizing.current = true;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [panelWidth]);

  const inputCls = 'w-full bg-surface-2 border border-accent-amber/15 px-3 py-1.5 text-xs text-accent-cream focus:outline-none focus:border-accent-amber/40 font-mono';
  const errorInputCls = 'w-full bg-surface-2 border border-accent-red/60 px-3 py-1.5 text-xs text-accent-cream focus:outline-none focus:border-accent-red font-mono';

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Panel */}
      <div
        className="relative h-full flex flex-col bg-surface-1 border-l border-accent-amber/15 shadow-2xl shadow-black/60 w-full md:w-auto"
        style={{ maxWidth: '100vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Resize handle - hidden on mobile */}
        <div
          onMouseDown={onResizeStart}
          className="hidden md:block absolute left-0 top-0 bottom-0 w-[5px] cursor-col-resize z-30 group"
        >
          <div className="absolute left-[1px] top-0 bottom-0 w-px bg-accent-amber/10 group-hover:bg-accent-amber/40 transition-colors" />
        </div>

        {/* Use inline style for desktop width */}
        <style>{`
          @media (min-width: 768px) {
            .task-panel-inner { width: ${panelWidth}px !important; }
          }
        `}</style>

        <div className="task-panel-inner flex flex-col h-full w-full">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-accent-amber/10 bg-surface-2/50 flex-shrink-0">
            <h3 className="text-xs font-semibold text-accent-amber uppercase tracking-[0.2em] font-mono">{isNew ? 'New Task' : 'Edit Task'}</h3>
            <button onClick={onClose} className="p-1 hover:bg-accent-amber/10 text-accent-cream/30 hover:text-accent-amber transition font-mono">&#x2715;</button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(180,160,100,0.15) transparent' }}>
            <Field label="Title" error={touched.title && errors.title}>
              <input
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                onBlur={() => touch('title')}
                className={touched.title && errors.title ? errorInputCls : inputCls}
                placeholder="Task name"
              />
            </Field>
            <Field label="Description">
              <textarea
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                className={inputCls + ' resize-y min-h-[60px]'}
                placeholder="Optional description"
                rows={3}
              />
            </Field>

            {/* Project + Sprint selectors */}
            {isNew ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Project">
                  <select value={selectedProjectId} onChange={(e) => handleProjectChange(e.target.value)} className={inputCls}>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id} className="bg-surface-2">{p.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Sprint">
                  {creatingSprint ? (
                    <div className="flex items-center gap-1">
                      <input
                        ref={newSprintInputRef}
                        type="text"
                        value={newSprintName}
                        onChange={(e) => setNewSprintName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitNewSprint(); }
                          else if (e.key === 'Escape') { e.preventDefault(); cancelNewSprint(); }
                        }}
                        placeholder="New sprint name"
                        className={inputCls}
                      />
                      <button
                        type="button"
                        onClick={commitNewSprint}
                        className="px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-accent-amber/70 hover:text-accent-amber border border-accent-amber/20 hover:border-accent-amber/40 hover:bg-accent-amber/10 transition"
                        title="Create sprint"
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={cancelNewSprint}
                        className="px-1.5 py-1.5 text-[10px] font-mono text-accent-cream/40 hover:text-accent-cream/70 transition"
                        title="Cancel"
                        aria-label="Cancel"
                      >
                        &#x2715;
                      </button>
                    </div>
                  ) : (
                    <select
                      value={form.sprintId || ''}
                      onChange={(e) => handleSprintSelectChange(e.target.value)}
                      className={inputCls}
                    >
                      {filteredSprints.length === 0 && (
                        <option value="" disabled className="bg-surface-2">No sprints yet</option>
                      )}
                      {filteredSprints.map((s) => (
                        <option key={s.id} value={s.id} className="bg-surface-2">{s.name}</option>
                      ))}
                      <option value={NEW_SPRINT_SENTINEL} className="bg-surface-2">+ New Sprint…</option>
                    </select>
                  )}
                </Field>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Sprint">
                  <select value={form.sprintId} onChange={(e) => set('sprintId', e.target.value)} className={inputCls}>
                    {sprints.map((s) => (
                      <option key={s.id} value={s.id} className="bg-surface-2">{s.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Status">
                  <select value={form.status} onChange={(e) => set('status', e.target.value)} className={inputCls}>
                    {['todo', 'in-progress', 'done', 'blocked'].map((s) => (
                      <option key={s} value={s} className="bg-surface-2">{s}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}

            {isNew && (
              <Field label="Status">
                <select value={form.status} onChange={(e) => set('status', e.target.value)} className={inputCls}>
                  {['todo', 'in-progress', 'done', 'blocked'].map((s) => (
                    <option key={s} value={s} className="bg-surface-2">{s}</option>
                  ))}
                </select>
              </Field>
            )}

            <div className="grid grid-cols-3 gap-3">
              <Field label="Start Date">
                <input
                  type="date"
                  value={form.startDate || ''}
                  onChange={(e) => { set('startDate', e.target.value); touch('startDate'); }}
                  onBlur={() => touch('startDate')}
                  className={inputCls}
                  style={{ colorScheme: 'dark' }}
                />
              </Field>
              <Field label="End Date" error={touched.endDate && errors.endDate}>
                <input
                  type="date"
                  value={form.endDate || ''}
                  onChange={(e) => { set('endDate', e.target.value); touch('endDate'); }}
                  onBlur={() => touch('endDate')}
                  className={touched.endDate && errors.endDate ? errorInputCls : inputCls}
                  style={{ colorScheme: 'dark' }}
                />
              </Field>
              <Field label="Due Date" error={touched.dueDate && errors.dueDate}>
                <input
                  type="date"
                  value={form.dueDate || ''}
                  onChange={(e) => { set('dueDate', e.target.value); touch('dueDate'); }}
                  onBlur={() => touch('dueDate')}
                  className={touched.dueDate && errors.dueDate ? errorInputCls : inputCls}
                  style={{ colorScheme: 'dark' }}
                />
              </Field>
            </div>
            <Field label="Dependencies">
              <div className="space-y-2">
                <div className="relative">
                  <input
                    type="text"
                    value={depQuery}
                    placeholder="Search tasks to add a dependency..."
                    onChange={(e) => { setDepQuery(e.target.value); setDepHighlight(0); }}
                    onFocus={() => {
                      if (depBlurTimer.current) clearTimeout(depBlurTimer.current);
                      setDepFocused(true);
                    }}
                    onBlur={() => {
                      depBlurTimer.current = setTimeout(() => setDepFocused(false), 150);
                    }}
                    onKeyDown={onDepKeyDown}
                    className={inputCls}
                  />
                  {depFocused && depSuggestions.length > 0 && (
                    <div
                      className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto border border-accent-amber/20 bg-surface-2 shadow-xl shadow-black/60"
                      style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(180,160,100,0.15) transparent' }}
                    >
                      {depSuggestions.map((t, i) => {
                        const crumb = taskBreadcrumb(t);
                        const highlighted = i === depHighlight;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setDepHighlight(i)}
                            onClick={() => addDependency(t.id)}
                            className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 transition ${
                              highlighted ? 'bg-accent-amber/15' : 'hover:bg-accent-amber/10'
                            }`}
                          >
                            <span className="text-xs text-accent-cream font-mono truncate flex-1 min-w-0">{t.title || '(untitled)'}</span>
                            {crumb && (
                              <span className="text-[10px] text-accent-cream/30 font-mono truncate">{crumb}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {depFocused && depSuggestions.length === 0 && depQuery.trim() && (
                    <div className="absolute z-20 left-0 right-0 mt-1 px-3 py-2 border border-accent-amber/15 bg-surface-2 text-[11px] text-accent-cream/30 font-mono">
                      No matching tasks.
                    </div>
                  )}
                </div>

                {(form.dependencies || []).length === 0 ? (
                  <div className="text-[11px] text-accent-cream/25 font-mono italic">No dependencies.</div>
                ) : (
                  <div className="space-y-1">
                    {(form.dependencies || []).map((edge) => {
                      const target = taskMap[edge.targetId];
                      const crumb = taskBreadcrumb(target);
                      return (
                        <div key={edge.targetId} className="flex items-center gap-2 px-2 py-1 bg-surface-2 border border-accent-amber/10">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-accent-cream font-mono truncate">
                              {target ? (target.title || '(untitled)') : <span className="italic text-accent-red/70">Missing: {edge.targetId}</span>}
                            </div>
                            {crumb && <div className="text-[10px] text-accent-cream/30 font-mono truncate">{crumb}</div>}
                          </div>
                          <select
                            value={edge.type}
                            onChange={(e) => changeDependencyType(edge.targetId, e.target.value)}
                            className="bg-surface-1 border border-accent-amber/15 px-1.5 py-0.5 text-[10px] text-accent-cream focus:outline-none focus:border-accent-amber/40 font-mono"
                            title="Edge type"
                          >
                            {EDGE_TYPES.map((t) => (
                              <option key={t} value={t} className="bg-surface-2">{EDGE_TYPE_LABELS[t]}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => removeDependency(edge.targetId)}
                            className="p-1 text-accent-cream/30 hover:text-accent-red transition"
                            aria-label="Remove dependency"
                            title="Remove dependency"
                          >
                            &#x2715;
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Urgency (1-10)">
                <input type="number" min={1} max={10} value={form.urgency} onChange={(e) => set('urgency', Math.min(10, Math.max(1, +e.target.value)))} className={inputCls} title="1=no deadline, 5=due this week, 10=drop everything" />
              </Field>
              <Field label="Importance (1-10)">
                <input type="number" min={1} max={10} value={form.importance} onChange={(e) => set('importance', Math.min(10, Math.max(1, +e.target.value)))} className={inputCls} title="1=not worth it, 5=building block, 10=existential" />
              </Field>
              <Field label="Difficulty (1-10)">
                <input type="number" min={1} max={10} value={form.difficulty} onChange={(e) => set('difficulty', Math.min(10, Math.max(1, +e.target.value)))} className={inputCls} title="1=done in an hour, 5=one month, 10=might be impossible" />
              </Field>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center gap-2 px-5 py-4 border-t border-accent-amber/10 flex-shrink-0">
            {!isNew && onDelete && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete task "${form.title || '(untitled)'}"?`)) {
                    onDelete(form.id);
                    onClose();
                  }
                }}
                className="px-4 py-1.5 text-xs text-accent-red/70 hover:text-accent-red border border-accent-red/30 hover:border-accent-red/60 hover:bg-accent-red/10 transition font-mono uppercase tracking-wider"
              >
                Delete
              </button>
            )}
            <div className="flex-1" />
            <button onClick={onClose} className="px-4 py-1.5 text-xs text-accent-cream/40 hover:text-accent-cream/70 transition font-mono uppercase tracking-wider">Cancel</button>
            <button
              disabled={hasErrors}
              onClick={() => {
                try { onSave(form); }
                catch (err) { console.error('[TaskModal] save failed:', err); }
                finally { onClose(); }
              }}
              className={
                hasErrors
                  ? 'px-4 py-1.5 text-xs bg-accent-amber/5 text-accent-cream/20 font-mono font-medium cursor-not-allowed uppercase tracking-wider'
                  : 'px-4 py-1.5 text-xs bg-accent-amber/15 hover:bg-accent-amber/25 text-accent-amber border border-accent-amber/30 font-mono font-medium transition uppercase tracking-wider'
              }
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
