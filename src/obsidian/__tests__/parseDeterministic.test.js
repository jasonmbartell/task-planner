import { describe, it, expect } from 'vitest';
import { parseMarkdownFile, tryParseDate, computeUrgencyFromDate } from '../parseDeterministic.js';

describe('tryParseDate', () => {
  it('parses ISO format', () => {
    expect(tryParseDate('2027-03-15')).toBe('2027-03-15');
  });

  it('parses "March 15 2027"', () => {
    expect(tryParseDate('March 15 2027')).toBe('2027-03-15');
  });

  it('parses "Mar 15, 2027"', () => {
    expect(tryParseDate('Mar 15, 2027')).toBe('2027-03-15');
  });

  it('parses month + year "Jan 2027"', () => {
    expect(tryParseDate('Jan 2027')).toBe('2027-01-01');
  });

  it('parses full month + year "January 2027"', () => {
    expect(tryParseDate('January 2027')).toBe('2027-01-01');
  });

  it('parses month-only "August" as 1st of current year', () => {
    const result = tryParseDate('August');
    expect(result).toMatch(/^\d{4}-08-01$/);
  });

  it('parses month-only "august" (lowercase)', () => {
    const result = tryParseDate('august');
    expect(result).toMatch(/^\d{4}-08-01$/);
  });

  it('parses year-only "2027"', () => {
    expect(tryParseDate('2027')).toBe('2027-01-01');
  });

  it('parses "Dec 2026"', () => {
    expect(tryParseDate('Dec 2026')).toBe('2026-12-01');
  });

  it('strips markdown bold and parses date', () => {
    expect(tryParseDate('**March 15 2027**')).toBe('2027-03-15');
  });

  it('strips trailing comma + text and parses date', () => {
    expect(tryParseDate('March 1 2027, **Next year**')).toBe('2027-03-01');
  });

  it('returns null for non-date text', () => {
    expect(tryParseDate('required before task X')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(tryParseDate('')).toBeNull();
  });
});

describe('parseMarkdownFile — Format B (indented metadata)', () => {
  it('parses user example with date urgency', () => {
    const md = `- [ ] taskname — description.
    - Urgency: March 15 2027
    - Importance: 1
    - Difficulty: 3
    - Additional notes`;

    const result = parseMarkdownFile(md);
    expect(result.tasks).toHaveLength(1);

    const task = result.tasks[0];
    expect(task.title).toBe('taskname');
    expect(task.description).toBe('description.');
    expect(task.status).toBe('todo');
    expect(task.dueDate).toBe('2027-03-15');
    expect(task.importance).toBe(1);
    expect(task.difficulty).toBe(3);
    // "Additional notes" should be in unrecognized lines
    expect(task._unrecognizedLines.some((l) => l.includes('Additional notes'))).toBe(true);
  });

  it('parses user example with child checkboxes treated as bullets', () => {
    const md = `- [x] task — description
    - [x] subtask
    - Urgency: required before task {}
    - Importance: Critical for financial separation of corporate and personal
    - Difficulty: 3`;

    const result = parseMarkdownFile(md);
    const task = result.tasks[0];

    expect(task.title).toBe('task');
    expect(task.description).toBe('description');
    expect(task.status).toBe('done');
    expect(task.difficulty).toBe(3);

    // Child checkboxes are treated as regular bullets, not subtasks
    // "subtask" has no key:value pattern so it becomes unrecognized
    expect(task._unrecognizedLines.some((l) => l.includes('subtask'))).toBe(true);

    // Ambiguous fields flagged
    expect(task._ambiguousFields.urgency).toBe('required before task {}');
    expect(task._ambiguousFields.importance).toBe('Critical for financial separation of corporate and personal');
  });
});

describe('parseMarkdownFile — Format A (legacy pipe)', () => {
  it('pipe-format dep list promotes bare tokens to hard-blocks edges', () => {
    const md = `- [ ] Task | id:task-a | dep:task-b, task-c (soft)`;
    const task = parseMarkdownFile(md).tasks[0];
    expect(task.dependencies).toEqual([
      { targetId: 'task-b', type: 'hard-blocks' },
      { targetId: 'task-c', type: 'soft-prefers' },
    ]);
  });

  it('drops user-supplied ids that do not match the canonical task-{nanoid} shape', () => {
    // Regression: a re-imported markdown file with `id:abc` (or any
    // non-canonical id token) used to land verbatim in `task.id`, which
    // the bulk validator rejected with "task.add: invalid task id 'abc'"
    // — the candidate list rendered but Apply silently failed.
    const cases = [
      `- [ ] Task | id:abc | urg:5`,
      `- [ ] Task | id:1 | urg:5`,
      `- [ ] Task | id: | urg:5`,
      `- [ ] Task — desc\n    - ID: foo`,
      `- [ ] Task — desc\n    - id: t-1`,
    ];
    for (const md of cases) {
      const task = parseMarkdownFile(md).tasks[0];
      expect(task.id).toBeNull();
      expect(task.title).toBe('Task');
    }
  });

  it('keeps user-supplied ids that already match the canonical shape', () => {
    expect(parseMarkdownFile(`- [ ] T | id:task-abc12345`).tasks[0].id).toBe('task-abc12345');
    expect(parseMarkdownFile(`- [ ] T — d\n    - id: task-abc12345`).tasks[0].id).toBe('task-abc12345');
  });

  it('parses pipe-delimited tasks', () => {
    const md = `## Project: My Project

### Sprint 1
- [ ] Task title | id:task-abc123 | urg:2 | imp:1 | diff:4 | due:2026-03-30
- [x] Completed | id:task-def456`;

    const result = parseMarkdownFile(md);
    expect(result.projectName).toBe('My Project');
    expect(result.sprints).toHaveLength(1);
    expect(result.sprints[0].sprintName).toBe('Sprint 1');
    expect(result.tasks).toHaveLength(2);

    const t1 = result.tasks[0];
    expect(t1.id).toBe('task-abc123');
    expect(t1.title).toBe('Task title');
    expect(t1.urgency).toBe(2);
    expect(t1.importance).toBe(1);
    expect(t1.difficulty).toBe(4);
    expect(t1.dueDate).toBe('2026-03-30');

    const t2 = result.tasks[1];
    expect(t2.status).toBe('done');
  });
});

describe('parseMarkdownFile — child checkboxes as bullets', () => {
  it('treats nested checkboxes as regular bullets, not subtasks', () => {
    const md = `- [ ] Parent task — Main description
    - [ ] Subtask one
    - [x] Subtask two
    - Urgency: 2`;

    const result = parseMarkdownFile(md);
    expect(result.tasks).toHaveLength(1);

    const parent = result.tasks[0];
    expect(parent.title).toBe('Parent task');
    expect(parent.urgency).toBe(2);
    // Child checkboxes become unrecognized lines (no key:value pattern)
    expect(parent._unrecognizedLines.some((l) => l.includes('Subtask one'))).toBe(true);
    expect(parent._unrecognizedLines.some((l) => l.includes('Subtask two'))).toBe(true);
  });

  it('parses child checkbox with metadata key as metadata', () => {
    const md = `- [x] Get an EIN
    - [ ] Due: Jan 15 2026`;

    const result = parseMarkdownFile(md);
    expect(result.tasks).toHaveLength(1);

    const task = result.tasks[0];
    expect(task.title).toBe('Get an EIN');
    expect(task.status).toBe('done');
    expect(task.dueDate).toBe('2026-01-15');
  });
});

describe('parseMarkdownFile — project/sprint headers', () => {
  it('uses filename as project name when no header', () => {
    const md = `- [ ] A task
    - Urgency: 1`;

    const result = parseMarkdownFile(md, 'my-project.md');
    expect(result.projectName).toBe('My Project');
  });

  it('creates default sprint when no # header', () => {
    const md = `- [ ] A task`;

    const result = parseMarkdownFile(md);
    expect(result.sprints[0].sprintName).toBe('Tasks');
  });

  it('handles multiple sprints', () => {
    const md = `## Project: Test

### Sprint A
- [ ] Task A

### Sprint B
- [ ] Task B`;

    const result = parseMarkdownFile(md);
    expect(result.sprints).toHaveLength(2);
    expect(result.sprints[0].sprintName).toBe('Sprint A');
    expect(result.sprints[1].sprintName).toBe('Sprint B');
    expect(result.tasks).toHaveLength(2);
  });
});

describe('computeUrgencyFromDate', () => {
  const ref = new Date('2026-03-24T00:00:00');

  it('returns 8 for overdue dates', () => {
    expect(computeUrgencyFromDate('2026-03-20', ref)).toBe(8);
  });

  it('returns 7 for today', () => {
    expect(computeUrgencyFromDate('2026-03-24', ref)).toBe(7);
  });

  it('returns 6 for tomorrow', () => {
    expect(computeUrgencyFromDate('2026-03-25', ref)).toBe(6);
  });

  it('returns 5 for this week', () => {
    expect(computeUrgencyFromDate('2026-03-28', ref)).toBe(5);
  });

  it('returns 4 for this month', () => {
    expect(computeUrgencyFromDate('2026-04-10', ref)).toBe(4);
  });

  it('returns 3 for more than a month out', () => {
    expect(computeUrgencyFromDate('2026-06-01', ref)).toBe(3);
  });

  it('returns 1 for empty/invalid input', () => {
    expect(computeUrgencyFromDate('', ref)).toBe(1);
    expect(computeUrgencyFromDate(null, ref)).toBe(1);
  });
});

describe('parseMarkdownFile — project description', () => {
  it('captures description after ## header', () => {
    const md = `## Acme Platform Setup
Registrations and preparation work

### Foundation
- [ ] Task A`;

    const result = parseMarkdownFile(md);
    expect(result.projectName).toBe('Acme Platform Setup');
    expect(result.projectDescription).toBe('Registrations and preparation work');
  });

  it('returns empty description when none present', () => {
    const md = `## My Project

### Sprint 1
- [ ] Task A`;

    const result = parseMarkdownFile(md);
    expect(result.projectDescription).toBe('');
  });
});

describe('parseMarkdownFile — dependency singular', () => {
  it('parses "Dependency:" as dependencies (promoted to hard-blocks edge)', () => {
    const md = `- [ ] Register on SAM.gov
    - Dependency: Create a Login.gov account`;

    const task = parseMarkdownFile(md).tasks[0];
    expect(task.dependencies).toEqual([
      { targetId: 'Create a Login.gov account', type: 'hard-blocks' },
    ]);
  });
});

describe('parseMarkdownFile — metadata parsing', () => {
  it('parses Due, Start, End dates', () => {
    const md = `- [ ] Task
    - Due: 2027-06-01
    - Start: 2027-05-01
    - End: 2027-05-31`;

    const task = parseMarkdownFile(md).tasks[0];
    expect(task.dueDate).toBe('2027-06-01');
    expect(task.startDate).toBe('2027-05-01');
    expect(task.endDate).toBe('2027-05-31');
  });

  it('parses dependencies as DepEdge[] (bare tokens → hard-blocks)', () => {
    const md = `- [ ] Task
    - Depends on: task-abc, task-def`;

    const task = parseMarkdownFile(md).tasks[0];
    expect(task.dependencies).toEqual([
      { targetId: 'task-abc', type: 'hard-blocks' },
      { targetId: 'task-def', type: 'hard-blocks' },
    ]);
  });

  it('parses typed edge annotations in dependency list', () => {
    const md = `- [ ] Task
    - Depends on: task-abc (soft), task-def (preempts), task-ghi`;

    const task = parseMarkdownFile(md).tasks[0];
    expect(task.dependencies).toEqual([
      { targetId: 'task-abc', type: 'soft-prefers' },
      { targetId: 'task-def', type: 'preempts' },
      { targetId: 'task-ghi', type: 'hard-blocks' },
    ]);
  });

  it('parses key:value annotations including note (respecting in-paren commas)', () => {
    const md = `- [ ] Task
    - Depends on: task-abc (type: soft, note: if possible), task-def`;

    const task = parseMarkdownFile(md).tasks[0];
    expect(task.dependencies).toEqual([
      { targetId: 'task-abc', type: 'soft-prefers', note: 'if possible' },
      { targetId: 'task-def', type: 'hard-blocks' },
    ]);
  });

  it('parses id for round-trip', () => {
    const md = `- [ ] Task
    - id: task-xyz789`;

    const task = parseMarkdownFile(md).tasks[0];
    expect(task.id).toBe('task-xyz789');
  });

  it('parses status overrides', () => {
    const md = `- [ ] Task
    - Status: in-progress`;

    const task = parseMarkdownFile(md).tasks[0];
    expect(task.status).toBe('in-progress');
  });
});
