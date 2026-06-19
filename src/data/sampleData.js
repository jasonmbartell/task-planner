import { PROJECT_COLORS } from '../utils/colors';

export const sampleProjects = [
  { id: 'proj-1', name: 'Mobile App', color: PROJECT_COLORS[4], description: 'Cross-platform task app' },
  { id: 'proj-2', name: 'Fundraising', color: PROJECT_COLORS[6], description: 'Investor pitch deck and outreach' },
  { id: 'proj-3', name: 'Marketing Site', color: PROJECT_COLORS[0], description: 'Company website and docs' },
];

export const sampleSprints = [
  { id: 'sprint-1', name: 'Sprint 1 — Foundation', startDate: '2026-03-16', endDate: '2026-03-29', projectId: 'proj-1' },
  { id: 'sprint-2', name: 'Sprint 2 — Sync Layer', startDate: '2026-03-30', endDate: '2026-04-12', projectId: 'proj-1' },
  { id: 'sprint-3', name: 'Pitch Prep', startDate: '2026-03-18', endDate: '2026-04-01', projectId: 'proj-2' },
  { id: 'sprint-4', name: 'Site Launch', startDate: '2026-03-20', endDate: '2026-04-05', projectId: 'proj-3' },
];

export const sampleTasks = [
  { id: 'task-1', title: 'Set up CI/CD pipeline', startDate: '2026-03-16', endDate: '2026-03-20', dueDate: '2026-03-21', dependencies: [], urgency: 5, importance: 8, difficulty: 4, sprintId: 'sprint-1', status: 'in-progress' },
  { id: 'task-2', title: 'Implement user authentication', startDate: '2026-03-20', endDate: '2026-03-24', dueDate: '2026-03-25', dependencies: ['task-1'], urgency: 4, importance: 7, difficulty: 3, sprintId: 'sprint-1', status: 'todo' },
  { id: 'task-3', title: 'Build offline data layer', startDate: '2026-03-24', endDate: '2026-03-28', dueDate: '2026-03-29', dependencies: ['task-1'], urgency: 4, importance: 7, difficulty: 5, sprintId: 'sprint-1', status: 'todo' },
  { id: 'task-4', title: 'Add real-time sync', startDate: '2026-03-30', endDate: '2026-04-04', dueDate: '2026-04-05', dependencies: ['task-3'], urgency: 3, importance: 8, difficulty: 5, sprintId: 'sprint-2', status: 'todo' },
  { id: 'task-5', title: 'Wire up push notifications', startDate: '2026-04-04', endDate: '2026-04-10', dueDate: '2026-04-12', dependencies: ['task-4'], urgency: 3, importance: 6, difficulty: 4, sprintId: 'sprint-2', status: 'todo' },
  { id: 'task-6', title: 'Draft pitch deck', startDate: '2026-03-18', endDate: '2026-03-25', dueDate: '2026-03-26', dependencies: [], urgency: 7, importance: 9, difficulty: 3, sprintId: 'sprint-3', status: 'in-progress' },
  { id: 'task-7', title: 'Build financial model', startDate: '2026-03-25', endDate: '2026-03-28', dueDate: '2026-03-30', dependencies: ['task-6'], urgency: 5, importance: 8, difficulty: 2, sprintId: 'sprint-3', status: 'todo' },
  { id: 'task-8', title: 'Write company one-pager', startDate: '2026-03-28', endDate: '2026-04-01', dueDate: '2026-04-01', dependencies: ['task-7'], urgency: 5, importance: 7, difficulty: 2, sprintId: 'sprint-3', status: 'todo' },
  { id: 'task-9', title: 'Design landing page', startDate: '2026-03-20', endDate: '2026-03-25', dueDate: '2026-03-26', dependencies: [], urgency: 5, importance: 5, difficulty: 2, sprintId: 'sprint-4', status: 'in-progress' },
  { id: 'task-10', title: 'Write product copy', startDate: '2026-03-25', endDate: '2026-03-30', dueDate: '2026-03-31', dependencies: ['task-9'], urgency: 4, importance: 5, difficulty: 2, sprintId: 'sprint-4', status: 'todo' },
  { id: 'task-11', title: 'Deploy to production', startDate: '2026-03-31', endDate: '2026-04-03', dueDate: '2026-04-05', dependencies: ['task-10'], urgency: 4, importance: 4, difficulty: 2, sprintId: 'sprint-4', status: 'todo' },
];
