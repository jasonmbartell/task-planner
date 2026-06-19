import { useState, useMemo, useEffect, useRef } from 'react';
import { Menu, Plus } from 'lucide-react';
import useStore from './store/useStore';
import { useSync } from './hooks/useSync';
import { useHydration } from './hooks/useHydration';
import { AgentSync } from './agent/AgentSync';
import { AgentInboxService } from './agent/inboxService';
import { AgentDigestService } from './agent/digestService';
import { sampleProjects, sampleSprints, sampleTasks } from './data/sampleData';
import GanttChart from './components/GanttChart';
import CalendarView from './components/CalendarView';
import SpreadsheetView from './components/SpreadsheetView';
import TaskModal from './components/TaskModal';
import Sidebar from './components/Sidebar';
import AppearanceSettings from './components/AppearanceSettings';
import AgentInbox from './components/AgentInbox';
import AgentDigest from './components/AgentDigest';
import IngestModal from './components/IngestModal';
import SyncStatus from './components/SyncStatus';
import ConnectStorage from './components/ConnectStorage';
import Toast from './components/Toast';
import ShortcutHelp from './components/ShortcutHelp';
import ProjectDashboard from './components/ProjectDashboard';
import AgendaView from './components/AgendaView';
import useKeyboardShortcuts from './hooks/useKeyboardShortcuts';
import useCustomCss from './hooks/useCustomCss';
import useAgentInbox from './hooks/useAgentInbox';
import { today, addDays } from './utils/dateUtils';

export default function App() {
  const sync = useSync();
  const hydrated = useHydration();

  const {
    projects, sprints, tasks,
    addProject, addSprint, addTask, updateTask, deleteTask,
    undo, redo,
  } = useStore();

  useCustomCss();

  const [view, setView] = useState('gantt');
  const [editTask, setEditTask] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showIngestModal, setShowIngestModal] = useState(false);

  // Close mobile menu when viewport enters desktop range
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const handler = (e) => { if (e.matches) setMobileMenuOpen(false); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleProjectClick = (projectId) => {
    setSelectedProjectId(projectId);
    setView('dashboard');
  };

  const selectedProject = useMemo(() => projects.find((p) => p.id === selectedProjectId), [projects, selectedProjectId]);

  const dashboardSprints = useMemo(() => {
    if (!selectedProjectId) return [];
    return sprints.filter((s) => s.projectId === selectedProjectId);
  }, [sprints, selectedProjectId]);

  const dashboardTasks = useMemo(() => {
    const sprintIds = new Set(dashboardSprints.map((s) => s.id));
    return tasks.filter((t) => sprintIds.has(t.sprintId));
  }, [tasks, dashboardSprints]);

  // Agent inbox review service (Milestone 4) — polls agent-archive/queued/.
  // Instantiated before AgentSync so AgentSync can trigger a refresh after archiving.
  const agentInboxRef = useRef(null);
  if (!agentInboxRef.current) agentInboxRef.current = new AgentInboxService(useStore);

  // Agent digest service (Milestone 5) — reads agent-log/*.jsonl on demand.
  const agentDigestRef = useRef(null);
  if (!agentDigestRef.current) agentDigestRef.current = new AgentDigestService(useStore);

  // Agent op-inbox listener (Tauri only; browser is a no-op). When a write
  // lands in any archive subdir, prod the inbox service so the badge/list
  // refresh without waiting on the 5s poll.
  const agentSyncRef = useRef(null);
  if (!agentSyncRef.current) {
    agentSyncRef.current = new AgentSync(useStore, {
      onAfterArchive: () => { agentInboxRef.current?.refresh().catch(() => {}); },
    });
  }

  const { count: agentInboxCount } = useAgentInbox(agentInboxRef.current);

  // Start the agent inbox listener once on mount.
  useEffect(() => {
    const agent = agentSyncRef.current;
    const inbox = agentInboxRef.current;
    agent.start();
    inbox.start().catch(() => {});
    return () => {
      agent.stop();
      inbox.stop();
    };
  }, []);

  // Seed sample data on first load
  useEffect(() => {
    // Read directly from the store to avoid stale closure with StrictMode double-firing
    if (useStore.getState().projects.length === 0) {
      sampleProjects.forEach((p) => addProject(p));
      sampleSprints.forEach((s) => addSprint(s));
      sampleTasks.forEach((t) => addTask(t));
    }
  }, []);

  const newTask = () => {
    setEditTask({
      id: '',
      title: '',
      startDate: today,
      endDate: addDays(today, 3),
      dueDate: addDays(today, 4),
      dependencies: [],
      urgency: 5,
      importance: 5,
      difficulty: 3,
      sprintId: sprints[0]?.id || '',
      status: 'todo',
    });
  };

  useKeyboardShortcuts({
    setView,
    onNewTask: newTask,
    undo,
    redo,
    toggleHelp: () => setShowShortcutHelp((v) => !v),
    closeModal: () => { setEditTask(null); setShowShortcutHelp(false); },
  });

  const handleTaskSave = (task) => {
    if (task.id && tasks.find((t) => t.id === task.id)) {
      updateTask(task.id, task);
    } else {
      addTask(task);
    }
  };

  const taskStats = useMemo(() => ({
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    inProg: tasks.filter((t) => t.status === 'in-progress').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
  }), [tasks]);

  if (!hydrated) return <div className="flex h-screen w-screen items-center justify-center bg-surface-0 text-accent-amber/50 font-mono text-sm">Loading...</div>;

  return (
    <div className="scanlines relative flex flex-1 w-screen overflow-hidden bg-surface-0 text-accent-cream font-sans" style={{ height: '100dvh' }}>
      {/* Mobile sidebar backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar — drawer on mobile, inline on desktop */}
      <div className={`
        fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-300
        md:static md:z-auto md:w-auto md:translate-x-0
        ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <Sidebar
          view={view}
          setView={setView}
          projects={projects}
          stats={taskStats}
          open={sidebarOpen}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
          onProjectClick={handleProjectClick}
          selectedProjectId={selectedProjectId}
          onNavigate={() => setMobileMenuOpen(false)}
          agentInboxCount={agentInboxCount}
          onIngest={() => setShowIngestModal(true)}
        />
      </div>

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 flex items-center justify-between px-3 md:px-5 border-b border-accent-amber/10 flex-shrink-0 bg-surface-1/80">
          <div className="flex items-center gap-2">
            {/* Hamburger — mobile only */}
            <button
              className="md:hidden min-w-[44px] min-h-[44px] flex items-center justify-center text-accent-amber/60 hover:text-accent-amber transition-colors"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-xs font-semibold text-accent-amber/70 uppercase tracking-[0.2em] font-mono flex items-center gap-2 truncate">
              {view === 'appearance' ? 'Appearance' : view === 'sync' ? 'Cloud Sync' : view === 'spreadsheet' ? 'All Projects' : view === 'agent-inbox' ? 'Agent Inbox' : view === 'agent-digest' ? 'Agent Digest' : view === 'agenda' ? 'Agenda' : view === 'dashboard' && selectedProject ? (
                <>
                  <div className="w-2.5 h-2.5 flex-shrink-0" style={{ background: selectedProject.color }} />
                  {selectedProject.name}
                </>
              ) : `${view} View`}
            </h1>
          </div>
          <div className="flex items-center gap-1 md:gap-3">
            <SyncStatus onRefresh={sync.refresh} />
            <button
              onClick={newTask}
              className="flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 text-xs bg-accent-amber/10 hover:bg-accent-amber/20 text-accent-amber border border-accent-amber/20 hover:border-accent-amber/40 font-mono font-medium tracking-wider uppercase transition-all"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden md:inline">New Task</span>
            </button>
          </div>
        </header>

        {/* View area */}
        <div className={`flex-1 min-h-0 ${view === 'appearance' || view === 'sync' || view === 'agent-inbox' || view === 'agent-digest' ? 'overflow-auto' : 'overflow-hidden'}`}>
          {view === 'gantt' && <GanttChart tasks={tasks} sprints={sprints} projects={projects} onTaskClick={setEditTask} onTaskDelete={deleteTask} />}
          {view === 'calendar' && <CalendarView tasks={tasks} projects={projects} sprints={sprints} onTaskClick={setEditTask} onTaskDelete={deleteTask} />}
          {view === 'spreadsheet' && <SpreadsheetView tasks={tasks} sprints={sprints} projects={projects} onTaskClick={setEditTask} onTaskDelete={deleteTask} />}
          {view === 'appearance' && <AppearanceSettings />}
          {view === 'agent-inbox' && <AgentInbox service={agentInboxRef.current} store={useStore} />}
          {view === 'agent-digest' && <AgentDigest service={agentDigestRef.current} onTaskClick={setEditTask} onProjectClick={handleProjectClick} />}
          {view === 'sync' && <ConnectStorage connectGoogle={sync.connectGoogle} connectMicrosoft={sync.connectMicrosoft} disconnect={sync.disconnect} />}
          {view === 'dashboard' && selectedProject && (
            <ProjectDashboard
              project={selectedProject}
              tasks={dashboardTasks}
              sprints={dashboardSprints}
              onTaskClick={setEditTask}
              onTaskDelete={deleteTask}
            />
          )}
          {view === 'agenda' && (
            <AgendaView tasks={tasks} sprints={sprints} projects={projects} onTaskClick={setEditTask} onTaskDelete={deleteTask} />
          )}
        </div>
      </main>

      <Toast />

      {showShortcutHelp && <ShortcutHelp onClose={() => setShowShortcutHelp(false)} />}

      {showIngestModal && (
        <IngestModal
          store={useStore}
          onClose={() => setShowIngestModal(false)}
        />
      )}

      {editTask && (
        <TaskModal
          task={editTask}
          onClose={() => setEditTask(null)}
          onSave={handleTaskSave}
          onDelete={deleteTask}
          sprints={sprints}
          projects={projects}
          tasks={tasks}
        />
      )}
    </div>
  );
}
