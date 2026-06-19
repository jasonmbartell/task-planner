const EXPORT_COLUMNS = [
  'title', 'status', 'startDate', 'endDate', 'dueDate',
  'urgency', 'importance', 'difficulty', 'project', 'sprint',
];

const EXPORT_HEADERS = [
  'Title', 'Status', 'Start Date', 'End Date', 'Due Date',
  'Urgency', 'Importance', 'Difficulty', 'Project', 'Sprint',
];

function escapeField(value) {
  const str = value == null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportTasksCsv(tasks, projects, sprints) {
  const projectMap = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const sprintMap = Object.fromEntries(sprints.map((s) => [s.id, s]));

  const rows = [EXPORT_HEADERS.join(',')];

  for (const task of tasks) {
    const sprint = sprintMap[task.sprintId];
    const projectName = sprint ? (projectMap[sprint.projectId] || '') : '';
    const sprintName = sprint ? sprint.name : '';

    const row = [
      task.title, task.status, task.startDate || '', task.endDate || '', task.dueDate || '',
      task.urgency, task.importance, task.difficulty, projectName, sprintName,
    ].map(escapeField);

    rows.push(row.join(','));
  }

  return rows.join('\n');
}

export function downloadCsv(csvString, filename = 'tasks.csv') {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

const VALID_STATUSES = new Set(['todo', 'in-progress', 'done', 'blocked']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clamp(val, min, max, fallback) {
  const n = Number(val);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function parseTasksCsv(csvString) {
  const lines = csvString.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return { tasks: [], errors: ['CSV must have a header row and at least one data row.'] };

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const titleIdx = headers.findIndex((h) => h === 'title');
  if (titleIdx === -1) return { tasks: [], errors: ['CSV must have a "Title" column.'] };

  const col = (name) => headers.indexOf(name);
  const tasks = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const title = (fields[titleIdx] || '').trim();

    if (!title) {
      errors.push({ row: i + 1, message: 'Missing title' });
      continue;
    }

    const statusRaw = (fields[col('status')] || '').trim().toLowerCase();
    const status = VALID_STATUSES.has(statusRaw) ? statusRaw : 'todo';

    const startDate = DATE_RE.test((fields[col('start date')] || '').trim()) ? fields[col('start date')].trim() : '';
    const endDate = DATE_RE.test((fields[col('end date')] || '').trim()) ? fields[col('end date')].trim() : '';
    const dueDate = DATE_RE.test((fields[col('due date')] || '').trim()) ? fields[col('due date')].trim() : '';

    const task = {
      title,
      status,
      startDate,
      endDate,
      dueDate,
      urgency: clamp(fields[col('urgency')], 1, 10, 5),
      importance: clamp(fields[col('importance')], 1, 10, 5),
      difficulty: clamp(fields[col('difficulty')], 1, 10, 3),
      _projectName: (fields[col('project')] || '').trim(),
      _sprintName: (fields[col('sprint')] || '').trim(),
    };

    tasks.push(task);
  }

  return { tasks, errors };
}
