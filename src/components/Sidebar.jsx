/**
 * Sidebar — Navigation + project list + task stats.
 *
 * Desktop: collapsible inline sidebar (w-56 open, w-14 collapsed).
 * Mobile: full-width drawer, visibility controlled by parent wrapper.
 */
import { useState, useRef, useEffect } from 'react';
import { GanttChart, CalendarDays, Table2, Cloud, Plus, Inbox, ScrollText, Sparkles, Palette, ListChecks } from 'lucide-react';
import useStore from '../store/useStore';
import { PROJECT_COLORS, getNextColor } from '../utils/colors';
import logo from '../assets/logo.png';
import TauriSettings from './TauriSettings.jsx';

export default function Sidebar({ view, setView, projects, stats, open, onToggle, onProjectClick, selectedProjectId, onNavigate, agentInboxCount = 0, onIngest }) {
  const updateProject = useStore((s) => s.updateProject);
  const addProject = useStore((s) => s.addProject);
  const [pickerOpenId, setPickerOpenId] = useState(null);
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const newProjectInputRef = useRef(null);
  const pickerRef = useRef(null);

  // Close picker when clicking outside
  useEffect(() => {
    if (!pickerOpenId) return;
    const handleClick = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setPickerOpenId(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [pickerOpenId]);

  const navItems = [
    { id: 'agenda', label: 'Agenda', icon: ListChecks },
    { id: 'gantt', label: 'Gantt', icon: GanttChart },
    { id: 'calendar', label: 'Calendar', icon: CalendarDays },
    { id: 'spreadsheet', label: 'All Projects', icon: Table2 },
    { id: 'agent-inbox', label: 'Inbox', icon: Inbox, badge: agentInboxCount },
    { id: 'agent-digest', label: 'Digest', icon: ScrollText },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'sync', label: 'Cloud', icon: Cloud },
  ];

  // On mobile the sidebar is always fully expanded (drawer controls visibility).
  // On desktop, `open` controls whether labels/projects/stats are shown.
  // We use "hidden md:hidden" to hide on both when collapsed, "md:inline"/"md:block" to show on desktop when open.
  const labelClass = open ? '' : 'hidden md:hidden';
  const sectionClass = open ? '' : 'hidden md:hidden';

  return (
    <aside className={`w-full ${open ? 'md:w-56' : 'md:w-14'} flex-shrink-0 border-r border-accent-amber/10 flex flex-col transition-all duration-300 bg-surface-1`}>
      {/* Logo — only toggles on desktop */}
      <div
        className="h-14 flex items-center px-4 border-b border-accent-amber/10 gap-3 cursor-pointer hidden md:flex"
        onClick={onToggle}
      >
        <img src={logo} alt="Logo" className="w-7 h-7 flex-shrink-0 object-contain" />
        {open && <span className="text-sm font-semibold text-accent-cream/80 tracking-[0.15em] uppercase font-mono">Planner</span>}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 space-y-0.5 px-2 overflow-y-auto">
        {onIngest && (
          <button
            onClick={() => { onIngest(); onNavigate?.(); }}
            className="w-full flex items-center gap-3 px-3 py-2 min-h-[44px] text-xs font-mono font-medium uppercase tracking-wider transition-all text-accent-amber/70 hover:text-accent-amber hover:bg-accent-amber/10 border-l-2 border-accent-amber/30 hover:border-accent-amber"
            aria-label="Ingest tasks from text"
            title="Ingest prose or structured text into tasks"
          >
            <Sparkles className="w-4 h-4 flex-shrink-0" />
            <span className={`${labelClass} flex-1 text-left`}>Ingest</span>
          </button>
        )}
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => { setView(item.id); onNavigate?.(); }}
            className={`w-full flex items-center gap-3 px-3 py-2 min-h-[44px] text-xs font-mono font-medium uppercase tracking-wider transition-all ${
              view === item.id
                ? 'bg-accent-amber/10 text-accent-amber border-l-2 border-accent-amber'
                : 'text-accent-cream/30 hover:text-accent-cream/60 hover:bg-accent-amber/5 border-l-2 border-transparent'
            }`}
          >
            <span className="relative flex-shrink-0">
              <item.icon className="w-4 h-4" />
              {item.badge > 0 && !open && (
                <span
                  className="absolute -top-1 -right-1 w-2 h-2 bg-accent-red rounded-full md:block hidden"
                  aria-label={`${item.badge} queued`}
                  title={`${item.badge} queued`}
                />
              )}
            </span>
            <span className={`${labelClass} flex-1 text-left`}>{item.label}</span>
            {item.badge > 0 && (
              <span
                className={`${labelClass} min-w-[1.25rem] px-1.5 py-0.5 text-[9px] font-bold tracking-wider bg-accent-red/20 text-accent-red border border-accent-red/40 text-center`}
                aria-label={`${item.badge} queued`}
                title={`${item.badge} queued`}
              >
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Projects */}
      <div className={`px-3 pb-4 ${sectionClass}`}>
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-[9px] text-accent-amber/30 uppercase tracking-[0.25em] font-semibold font-mono">
            Projects
          </span>
          <button
            type="button"
            onClick={() => {
              setAddingProject(true);
              setTimeout(() => newProjectInputRef.current?.focus(), 0);
            }}
            className="min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 md:w-4 md:h-4 flex items-center justify-center text-accent-amber/30 hover:text-accent-amber/70 hover:bg-accent-amber/10 transition-all"
            aria-label="Add project"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
        {projects.map((p) => (
          <div
            key={p.id}
            className={`relative flex items-center gap-2 px-2 py-1.5 min-h-[44px] hover:bg-accent-amber/5 transition cursor-pointer ${
              view === 'dashboard' && selectedProjectId === p.id ? 'bg-accent-amber/10 border-l-2 border-accent-amber' : 'border-l-2 border-transparent'
            }`}
            onClick={() => { onProjectClick?.(p.id); onNavigate?.(); }}
          >
            <button
              type="button"
              className="w-3 h-3 flex-shrink-0 border border-accent-cream/20 hover:border-accent-cream/40 transition-all focus:outline-none"
              style={{ background: p.color }}
              onClick={(e) => {
                e.stopPropagation();
                setPickerOpenId(pickerOpenId === p.id ? null : p.id);
              }}
              aria-label={`Change color for ${p.name}`}
            />
            <span className="text-[11px] text-accent-cream/50 truncate font-mono">{p.name}</span>

            {/* Color Picker Popover */}
            {pickerOpenId === p.id && (
              <div
                ref={pickerRef}
                className="absolute left-6 top-full mt-1 z-50 p-2 border border-accent-amber/20 bg-surface-2 shadow-xl shadow-black/60"
              >
                <div className="grid grid-cols-4 gap-1.5">
                  {PROJECT_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`w-8 h-8 md:w-5 md:h-5 transition-all hover:scale-110 focus:outline-none ${
                        p.color === color ? 'ring-2 ring-accent-amber ring-offset-1 ring-offset-surface-2' : 'border border-accent-cream/10'
                      }`}
                      style={{ background: color }}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateProject(p.id, { color });
                        setPickerOpenId(null);
                      }}
                      aria-label={`Select color ${color}`}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Inline new project input */}
        {addingProject && (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="w-3 h-3 flex-shrink-0 bg-accent-amber/30" />
            <input
              ref={newProjectInputRef}
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newProjectName.trim()) {
                  const usedColors = projects.map((p) => p.color);
                  addProject({ name: newProjectName.trim(), color: getNextColor(usedColors) });
                  setNewProjectName('');
                  setAddingProject(false);
                }
                if (e.key === 'Escape') {
                  setNewProjectName('');
                  setAddingProject(false);
                }
              }}
              onBlur={() => {
                if (newProjectName.trim()) {
                  const usedColors = projects.map((p) => p.color);
                  addProject({ name: newProjectName.trim(), color: getNextColor(usedColors) });
                }
                setNewProjectName('');
                setAddingProject(false);
              }}
              placeholder="Project name..."
              className="flex-1 min-w-0 bg-transparent text-[11px] text-accent-cream/70 placeholder-accent-cream/20 border-b border-accent-amber/30 outline-none font-mono py-0.5"
            />
          </div>
        )}
      </div>

      {/* Desktop Settings (Tauri only) */}
      <TauriSettings />

      {/* Stats */}
      <div className={`px-4 py-3 border-t border-accent-amber/10 space-y-1.5 ${sectionClass}`}>
        {[
          { label: 'Total', value: stats.total, color: 'text-accent-cream/30' },
          { label: 'In Progress', value: stats.inProg, color: 'text-accent-blue' },
          { label: 'Done', value: stats.done, color: 'text-accent-green' },
          { label: 'Blocked', value: stats.blocked, color: 'text-accent-red' },
        ].map((s) => (
          <div key={s.label} className="flex justify-between text-[10px] font-mono uppercase tracking-wider">
            <span className={s.color}>{s.label}</span>
            <span className={s.color}>{s.value}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
