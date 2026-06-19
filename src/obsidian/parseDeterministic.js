/**
 * Deterministic Markdown Parser
 *
 * Parses Obsidian task lists in three formats:
 *   A) Legacy pipe-delimited: - [ ] Title | id:x | urg:2 | imp:1
 *   B) Indented metadata bullets: - [ ] Title — desc \n    - Urgency: 3
 *   C) Subtask checkboxes: - [ ] Parent \n    - [ ] Child
 *
 * Fields that cannot be parsed deterministically are placed in _ambiguousFields
 * for optional LLM interpretation.
 */

import { parse as dateParse, isValid, differenceInCalendarDays } from 'date-fns';
import { parseEdgeToken } from '../utils/depEdges.js';

/**
 * Split a comma-separated dependency list, respecting parentheses so that
 * annotations like `task-a (type: soft, note: prefer)` are not cut in half.
 * Whitespace around each entry is trimmed; empty entries are dropped.
 */
function splitDepList(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of raw) {
    if (ch === '(') { depth++; buf += ch; continue; }
    if (ch === ')') { if (depth > 0) depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Turn a `Depends on: ...` value into a DepEdge[]. Bare tokens are
 * hard-blocks; `task-x (soft)` / `task-x (type: soft, note: ...)` carry
 * their annotation. Returns [] for empty/non-string input.
 */
function parseDepList(raw) {
  const tokens = splitDepList(raw);
  const edges = [];
  for (const token of tokens) {
    const edge = parseEdgeToken(token);
    if (edge) edges.push(edge);
  }
  return edges;
}

// ─── Date parsing ───

const DATE_FORMATS_WITH_YEAR = [
  'yyyy-MM-dd',
  'MMMM d yyyy',
  'MMMM d, yyyy',
  'MMM d yyyy',
  'MMM d, yyyy',
  'M/d/yyyy',
  'MM/dd/yyyy',
  'MM-dd-yyyy',
  'd MMMM yyyy',
  'd MMM yyyy',
  'MMMM yyyy',    // "January 2027" → 1st of month
  'MMM yyyy',     // "Jan 2027" → 1st of month
];

const DATE_FORMATS_NO_YEAR = [
  'MMMM d',
  'MMM d',
  'M/d',
  'MM/dd',
  'd MMMM',
  'd MMM',
  'MMMM',         // "August" → 1st of month, current year
  'MMM',          // "Aug" → 1st of month, current year
];

/**
 * Strip markdown formatting (bold, italic) and trailing noise from text
 * to expose the date underneath.
 */
function cleanDateText(text) {
  let cleaned = text
    .replace(/\*\*([^*]*)\*\*/g, '$1')   // **bold** → bold
    .replace(/\*([^*]*)\*/g, '$1')        // *italic* → italic
    .replace(/__([^_]*)__/g, '$1')        // __bold__ → bold
    .replace(/_([^_]*)_/g, '$1')          // _italic_ → italic
    .trim();
  // Strip trailing comma + extra text (e.g. "March 1 2027, Next year")
  const commaIdx = cleaned.indexOf(',');
  if (commaIdx > 0) {
    cleaned = cleaned.slice(0, commaIdx).trim();
  }
  return cleaned;
}

/**
 * Try to parse a string as a date using multiple formats.
 * Returns ISO date string (YYYY-MM-DD) or null.
 */
export function tryParseDate(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const now = new Date();
  const formatISO = (result) => {
    const y = result.getFullYear();
    const m = String(result.getMonth() + 1).padStart(2, '0');
    const d = String(result.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  // Try raw text first, then cleaned text (strips markdown bold/italic, trailing commas)
  const candidates = [trimmed];
  const cleaned = cleanDateText(trimmed);
  if (cleaned !== trimmed) candidates.push(cleaned);

  // Year-only check (e.g. "2027" → January 1)
  for (const candidate of candidates) {
    if (/^\d{4}$/.test(candidate)) {
      return `${candidate}-01-01`;
    }
  }

  for (const candidate of candidates) {
    // Try formats that include a year first
    for (const fmt of DATE_FORMATS_WITH_YEAR) {
      const result = dateParse(candidate, fmt, now);
      if (isValid(result)) return formatISO(result);
    }

    // Try year-less formats, defaulting to current year
    for (const fmt of DATE_FORMATS_NO_YEAR) {
      const result = dateParse(candidate, fmt, now);
      if (isValid(result)) return formatISO(result);
    }
  }

  return null;
}

// ─── Urgency from date distance ───

/**
 * Compute urgency (1-10) from a due date string based on distance from today.
 * Scale: past/today=7, tomorrow=6, this week=5, this month=4, >1 month=3, no date=1
 *
 * @param {string} isoDate - ISO date string (YYYY-MM-DD)
 * @param {Date} [referenceDate] - Reference date (defaults to today)
 * @returns {number} urgency 1-10
 */
export function computeUrgencyFromDate(isoDate, referenceDate) {
  if (!isoDate) return 1;
  const due = new Date(isoDate + 'T00:00:00');
  if (!isValid(due)) return 1;

  const today = referenceDate || new Date();
  today.setHours(0, 0, 0, 0);
  const days = differenceInCalendarDays(due, today);

  if (days < 0) return 8;    // overdue
  if (days === 0) return 7;   // due today
  if (days === 1) return 6;   // due tomorrow
  if (days <= 7) return 5;    // due this week
  if (days <= 30) return 4;   // due this month
  return 3;                    // due a month+ out
}

// ─── Indentation helpers ───

function getIndentLevel(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

// ─── Legacy pipe format parser ───

// Mirrors TASK_ID_RE in src/agent/validate.js. User-supplied IDs from a
// markdown re-import (e.g. `id:abc` in the legacy pipe format, or
// `- ID: foo` in the indented metadata format) are dropped to null when
// they don't match this canonical shape so `assignMissingIds` can issue
// fresh `task-{nanoid}` IDs. Without this, the bulk validator rejects the
// envelope with `task.add: invalid task id "abc"` and the candidates
// extracted in the modal silently fail to apply.
const CANONICAL_TASK_ID_RE = /^task-[A-Za-z0-9_-]+$/;
function sanitizeTaskId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return CANONICAL_TASK_ID_RE.test(trimmed) ? trimmed : null;
}

function parsePipeLine(rest, done) {
  const parts = rest.split('|').map((s) => s.trim());
  const title = parts[0];

  const meta = {};
  for (let i = 1; i < parts.length; i++) {
    const colonIdx = parts[i].indexOf(':');
    if (colonIdx > 0) {
      const key = parts[i].slice(0, colonIdx).trim();
      const val = parts[i].slice(colonIdx + 1).trim();
      meta[key] = val;
    }
  }

  let status = done ? 'done' : 'todo';
  if (meta.st && ['in-progress', 'blocked'].includes(meta.st)) {
    status = meta.st;
  }

  return {
    id: sanitizeTaskId(meta.id),
    title,
    description: meta.desc ? meta.desc.replace(/\\n/g, '\n') : '',
    status,
    startDate: meta.start || '',
    endDate: meta.end || '',
    dueDate: meta.due || '',
    urgency: meta.urg ? parseInt(meta.urg, 10) : null,
    importance: meta.imp ? parseInt(meta.imp, 10) : null,
    difficulty: meta.diff ? parseInt(meta.diff, 10) : null,
    dependencies: meta.dep ? parseDepList(meta.dep) : [],
    _ambiguousFields: {},
    _subtasks: [],
    _originalLines: [],
    _isLegacyFormat: true,
  };
}

// ─── Metadata line parser ───

const METADATA_KEYS = {
  urgency: 'urgency',
  urg: 'urgency',
  importance: 'importance',
  impact: 'importance',
  imp: 'importance',
  projectimpact: 'importance',
  difficulty: 'difficulty',
  diff: 'difficulty',
  due: 'dueDate',
  'due date': 'dueDate',
  'duedate': 'dueDate',
  start: 'startDate',
  'start date': 'startDate',
  'startdate': 'startDate',
  end: 'endDate',
  'end date': 'endDate',
  'enddate': 'endDate',
  status: 'status',
  st: 'status',
  id: 'id',
  dependency: 'dependencies',
  dependencies: 'dependencies',
  'depends on': 'dependencies',
  dep: 'dependencies',
};

const STATUS_MAP = {
  done: 'done',
  completed: 'done',
  complete: 'done',
  todo: 'todo',
  'to do': 'todo',
  'to-do': 'todo',
  'in progress': 'in-progress',
  'in-progress': 'in-progress',
  blocked: 'blocked',
};

/**
 * Parse a metadata line like "- Urgency: 3" or "- Importance: Critical for..."
 * Returns { field, value, isAmbiguous } or null if not a recognized metadata line.
 */
function parseMetadataLine(line) {
  const trimmed = line.trim();

  // Must be a bullet without checkbox
  const match = trimmed.match(/^-\s+(.+)$/);
  if (!match) return null;

  const content = match[1];

  // Check for key: value pattern
  const colonIdx = content.indexOf(':');
  if (colonIdx <= 0) return null;

  const rawKey = content.slice(0, colonIdx).trim().toLowerCase();
  const rawValue = content.slice(colonIdx + 1).trim();

  const field = METADATA_KEYS[rawKey];
  if (!field) return null;

  // Parse based on field type
  if (field === 'id') {
    // Drop user-supplied IDs that don't match the canonical task-{nanoid}
    // shape. assignMissingIds will issue a fresh ID at apply time. See the
    // sanitizeTaskId comment above for the rationale.
    return { field: 'id', value: sanitizeTaskId(rawValue), isAmbiguous: false };
  }

  if (field === 'dependencies') {
    return { field: 'dependencies', value: parseDepList(rawValue), isAmbiguous: false };
  }

  if (field === 'status') {
    const mapped = STATUS_MAP[rawValue.toLowerCase()];
    if (mapped) return { field: 'status', value: mapped, isAmbiguous: false };
    return { field: 'status', value: rawValue, isAmbiguous: true };
  }

  if (field === 'dueDate' || field === 'startDate' || field === 'endDate') {
    const date = tryParseDate(rawValue);
    if (date) return { field, value: date, isAmbiguous: false };
    return { field, value: rawValue, isAmbiguous: true };
  }

  if (field === 'urgency') {
    // Could be a number (urgency rating) or a date (due date) or text
    const num = parseInt(rawValue, 10);
    if (!isNaN(num) && String(num) === rawValue.trim() && num >= 1 && num <= 10) {
      return { field: 'urgency', value: num, isAmbiguous: false };
    }
    // Try as a date -> maps to dueDate + inferred urgency
    const date = tryParseDate(rawValue);
    if (date) {
      return { field: '_urgencyDate', value: date, isAmbiguous: false };
    }
    // Ambiguous text
    return { field: 'urgency', value: rawValue, isAmbiguous: true };
  }

  if (field === 'importance') {
    const num = parseInt(rawValue, 10);
    if (!isNaN(num) && String(num) === rawValue.trim() && num >= 1 && num <= 10) {
      return { field: 'importance', value: num, isAmbiguous: false };
    }
    return { field: 'importance', value: rawValue, isAmbiguous: true };
  }

  if (field === 'difficulty') {
    const num = parseInt(rawValue, 10);
    if (!isNaN(num) && String(num) === rawValue.trim() && num >= 1 && num <= 10) {
      return { field: 'difficulty', value: num, isAmbiguous: false };
    }
    return { field: 'difficulty', value: rawValue, isAmbiguous: true };
  }

  return null;
}

// ─── Title / description splitting ───

function splitTitleDescription(text) {
  // Try em-dash variants: — , -- , ---
  for (const sep of [' \u2014 ', ' — ', ' -- ', ' --- ']) {
    const idx = text.indexOf(sep);
    if (idx > 0) {
      return {
        title: text.slice(0, idx).trim(),
        description: text.slice(idx + sep.length).trim(),
      };
    }
  }
  // Also try em-dash without spaces
  const emIdx = text.indexOf('\u2014');
  if (emIdx > 0) {
    return {
      title: text.slice(0, emIdx).trim(),
      description: text.slice(emIdx + 1).trim(),
    };
  }
  return { title: text.trim(), description: '' };
}

// ─── Main file parser ───

/**
 * Parse an entire markdown file into structured task data.
 *
 * @param {string} content - Markdown file content
 * @param {string} [fileName] - Optional filename (used as project name fallback)
 * @returns {{ projectName, sprints: Array<{sprintName, tasks}>, tasks: Array }}
 */
export function parseMarkdownFile(content, fileName) {
  const lines = content.split('\n');
  let projectName = fileName
    ? fileName.replace(/\.md$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Default Project';
  let projectDescription = '';
  let hasProjectHeader = false;
  let currentSprint = null;
  const sprints = new Map();

  // First pass: identify task lines and their children
  const taskBlocks = []; // { taskLineIdx, indent, childLines: [{idx, indent}] }
  let currentBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = getIndentLevel(line);

    // Project header (## level)
    const projectMatch = trimmed.match(/^##\s+(?:Project:\s*)?(.+)$/);
    if (projectMatch && !trimmed.startsWith('###')) {
      projectName = projectMatch[1].trim();
      hasProjectHeader = true;
      // Capture description from the next non-empty line (if it's plain text)
      for (let j = i + 1; j < lines.length; j++) {
        const nextTrimmed = lines[j].trim();
        if (!nextTrimmed) continue; // skip blank lines
        if (!nextTrimmed.startsWith('#') && !nextTrimmed.startsWith('- ')) {
          projectDescription = nextTrimmed;
        }
        break;
      }
      continue;
    }

    // Sprint header (### level)
    if (trimmed.startsWith('### ')) {
      currentSprint = trimmed.slice(4).trim();
      // Strip optional "Sprint:" prefix
      if (currentSprint.toLowerCase().startsWith('sprint:')) {
        currentSprint = currentSprint.slice('sprint:'.length).trim();
      }
      if (!sprints.has(currentSprint)) {
        sprints.set(currentSprint, []);
      }
      continue;
    }

    // Task line (checkbox)
    const taskMatch = trimmed.match(/^- \[([ x])\] (.+)$/);
    if (taskMatch) {
      // If this is a top-level task (at base indent or lower indent than current block's children)
      if (!currentBlock || indent <= currentBlock.indent) {
        // Save previous block
        if (currentBlock) taskBlocks.push(currentBlock);
        currentBlock = {
          lineIdx: i,
          indent,
          line: trimmed,
          rawLine: line,
          done: taskMatch[1] === 'x',
          rest: taskMatch[2],
          sprintName: currentSprint,
          childLines: [],
        };
      } else {
        // Indented checkbox — treat as a regular bullet (strip checkbox marker)
        // This handles cases where users accidentally use checkboxes for metadata
        if (currentBlock) {
          const childContent = taskMatch[2];
          currentBlock.childLines.push({
            idx: i,
            indent,
            line: `- ${childContent}`,
            rawLine: line,
            isCheckbox: false,
          });
        }
      }
      continue;
    }

    // Non-checkbox indented line under a task
    if (currentBlock && indent > currentBlock.indent && trimmed) {
      currentBlock.childLines.push({
        idx: i,
        indent,
        line: trimmed,
        rawLine: line,
        isCheckbox: false,
      });
    }
  }
  // Push last block
  if (currentBlock) taskBlocks.push(currentBlock);

  // If no sprint headers, use default
  if (sprints.size === 0 && !currentSprint) {
    currentSprint = 'Tasks';
  }

  // Second pass: convert task blocks to parsed tasks
  const allTasks = [];

  for (const block of taskBlocks) {
    const sprintName = block.sprintName || currentSprint || 'Tasks';
    if (!sprints.has(sprintName)) {
      sprints.set(sprintName, []);
    }

    // Detect legacy pipe format
    const hasPipes = block.rest.includes('|');
    let task;

    if (hasPipes) {
      task = parsePipeLine(block.rest, block.done);
    } else {
      const { title, description } = splitTitleDescription(block.rest);
      task = {
        id: null,
        title,
        description,
        status: block.done ? 'done' : 'todo',
        startDate: '',
        endDate: '',
        dueDate: '',
        urgency: null,
        importance: null,
        difficulty: null,
        dependencies: [],
        _ambiguousFields: {},
        _subtasks: [],
        _originalLines: [],
        _isLegacyFormat: false,
      };
    }

    // Collect original lines
    task._originalLines.push(block.rawLine);

    // Process child lines — all treated as metadata or unrecognized text
    const unrecognizedLines = [];

    for (const child of block.childLines) {
      task._originalLines.push(child.rawLine);

      if (!hasPipes) {
        // Metadata or unrecognized line
        const meta = parseMetadataLine(child.line);
        if (meta) {
          if (meta.isAmbiguous) {
            task._ambiguousFields[meta.field] = meta.value;
          } else if (meta.field === '_urgencyDate') {
            // Date found in urgency field: set dueDate and infer urgency from distance
            task.dueDate = meta.value;
            if (task.urgency == null) task.urgency = computeUrgencyFromDate(meta.value);
          } else if (meta.field === 'dependencies') {
            task.dependencies = meta.value;
          } else {
            task[meta.field] = meta.value;
          }
        } else {
          // Unrecognized line — preserve
          unrecognizedLines.push(child.rawLine);
        }
      }
    }
    task._unrecognizedLines = unrecognizedLines;
    task._sprintName = sprintName;
    task._projectName = projectName;

    sprints.get(sprintName).push(task);
    allTasks.push(task);
  }

  // Build sprint groups
  const sprintGroups = [];
  for (const [sprintName, tasks] of sprints) {
    sprintGroups.push({ sprintName, tasks });
  }

  return { projectName, projectDescription, sprints: sprintGroups, tasks: allTasks };
}
