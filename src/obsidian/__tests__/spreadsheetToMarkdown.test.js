import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

import {
  spreadsheetToMarkdown,
  rowsToMarkdownTable,
  dropBlankRows,
  trimTrailingEmptyColumns,
  pickSheetName,
  __TEST_ONLY__,
} from '../spreadsheetToMarkdown.js';
import { parseMarkdownIntelligent } from '../parseOrchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'spreadsheet');

describe('rowsToMarkdownTable (pure)', () => {
  it('emits a header + separator + data rows', () => {
    const md = rowsToMarkdownTable([
      ['Task', 'Owner', 'Due'],
      ['Ship it', 'Alice', '2026-05-01'],
      ['Cut release', '', '2026-05-15'],
    ]);
    const lines = md.split('\n');
    expect(lines[0]).toBe('| Task | Owner | Due |');
    expect(lines[1]).toBe('|---|---|---|');
    expect(lines[2]).toBe('| Ship it | Alice | 2026-05-01 |');
    expect(lines[3]).toBe('| Cut release |  | 2026-05-15 |');
  });

  it('prepends an H1 title when given', () => {
    const md = rowsToMarkdownTable([['A'], ['x']], { title: 'My Sheet' });
    expect(md.split('\n')[0]).toBe('# My Sheet');
    expect(md.split('\n')[1]).toBe('');
  });

  it('escapes pipes and collapses newlines into <br>', () => {
    const md = rowsToMarkdownTable([
      ['Title', 'Notes'],
      ['Build | API', 'line1\nline2\r\nline3'],
    ]);
    expect(md).toContain('| Build \\| API | line1<br>line2<br>line3 |');
  });

  it('pads rows that are shorter than the header', () => {
    const md = rowsToMarkdownTable([
      ['A', 'B', 'C'],
      ['x'],
    ]);
    expect(md.split('\n')[2]).toBe('| x |  |  |');
  });

  it('truncates rows that are longer than the header', () => {
    const md = rowsToMarkdownTable([
      ['A', 'B'],
      ['x', 'y', 'z'],
    ]);
    expect(md.split('\n')[2]).toBe('| x | y |');
  });

  it('returns empty string on empty input', () => {
    expect(rowsToMarkdownTable([])).toBe('');
  });
});

describe('dropBlankRows', () => {
  it('drops rows where every cell is empty/whitespace', () => {
    const filtered = dropBlankRows([
      ['', '', ''],
      ['  '],
      ['Task', 'Owner'],
      [null, undefined],
      ['Build', 'Alice'],
    ]);
    expect(filtered).toEqual([
      ['Task', 'Owner'],
      ['Build', 'Alice'],
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(dropBlankRows(null)).toEqual([]);
    expect(dropBlankRows('not an array')).toEqual([]);
  });
});

describe('trimTrailingEmptyColumns', () => {
  it('drops trailing all-empty columns across all rows', () => {
    const trimmed = trimTrailingEmptyColumns([
      ['Task', 'Owner', '', ''],
      ['Build', 'Alice', '', ''],
      ['Ship', 'Bob', '', ''],
    ]);
    expect(trimmed).toEqual([
      ['Task', 'Owner'],
      ['Build', 'Alice'],
      ['Ship', 'Bob'],
    ]);
  });

  it('keeps internal empty columns', () => {
    const trimmed = trimTrailingEmptyColumns([
      ['A', '', 'C'],
      ['1', '', '3'],
    ]);
    expect(trimmed).toEqual([
      ['A', '', 'C'],
      ['1', '', '3'],
    ]);
  });

  it('returns [] when every column is empty', () => {
    expect(trimTrailingEmptyColumns([['', ''], ['', '']])).toEqual([]);
  });

  it('passes empty/non-array input through', () => {
    expect(trimTrailingEmptyColumns([])).toEqual([]);
    expect(trimTrailingEmptyColumns(null)).toBe(null);
  });
});

describe('pickSheetName', () => {
  it('returns the first sheet that has any non-empty cell', () => {
    const wb = {
      SheetNames: ['Empty', 'Real'],
      Sheets: {
        Empty: { '!ref': 'A1:A1' },
        Real: { A1: { v: 'Task' }, B1: { v: 'Owner' } },
      },
    };
    expect(pickSheetName(wb)).toBe('Real');
  });

  it('falls back to the first sheet name when nothing has content', () => {
    const wb = { SheetNames: ['First', 'Second'], Sheets: { First: {}, Second: {} } };
    expect(pickSheetName(wb)).toBe('First');
  });

  it('honors a forced sheet name', () => {
    const wb = { SheetNames: ['A', 'B'], Sheets: { A: {}, B: { A1: { v: 'x' } } } };
    expect(pickSheetName(wb, 'B')).toBe('B');
  });

  it('throws when forced sheet does not exist', () => {
    const wb = { SheetNames: ['A'], Sheets: { A: {} } };
    expect(() => pickSheetName(wb, 'Missing')).toThrow(/not found/);
  });

  it('returns null on a bad workbook', () => {
    expect(pickSheetName(null)).toBe(null);
    expect(pickSheetName({})).toBe(null);
  });
});

describe('spreadsheetToMarkdown — string CSV input', () => {
  it('parses a plain CSV into a markdown table', async () => {
    const csv = 'Task,Owner,Due\nBuild,Alice,2026-05-01\nShip,Bob,2026-05-15\n';
    const result = await spreadsheetToMarkdown(csv);
    expect(result.rowCount).toBe(2);
    expect(result.columns).toEqual(['Task', 'Owner', 'Due']);
    expect(result.markdown).toContain('| Task | Owner | Due |');
    expect(result.markdown).toContain('| Build | Alice | 2026-05-01 |');
    expect(result.markdown).toContain('| Ship | Bob | 2026-05-15 |');
  });

  it('emits an H1 title when fileName is supplied', async () => {
    const result = await spreadsheetToMarkdown('A,B\n1,2\n', { fileName: 'tiny.csv' });
    expect(result.markdown.startsWith('# tiny.csv —')).toBe(true);
  });

  it('throws on empty input', async () => {
    await expect(spreadsheetToMarkdown('')).rejects.toThrow(/empty/i);
    await expect(spreadsheetToMarkdown(null)).rejects.toThrow(/empty/i);
  });

  it('throws when the sheet only has a header row', async () => {
    await expect(spreadsheetToMarkdown('Task,Owner\n')).rejects.toThrow(/no data rows/i);
  });
});

describe('spreadsheetToMarkdown — messy CSV fixture', () => {
  it('drops leading blank rows and trims trailing empty columns', async () => {
    const buf = readFileSync(join(FIXTURE_DIR, 'deployment-plan.csv'), 'utf8');
    const result = await spreadsheetToMarkdown(buf, { fileName: 'deployment-plan.csv' });

    // 7th column was blank (trailing comma) → must be trimmed
    expect(result.columns).toEqual(['Task', 'Owner', 'By when', 'Priority', 'Status', 'Notes']);
    expect(result.rowCount).toBe(4);

    // Title rendered, header row sits below it
    const lines = result.markdown.split('\n');
    expect(lines[0]).toBe('# deployment-plan.csv — Sheet1');
    expect(lines[2]).toBe('| Task | Owner | By when | Priority | Status | Notes |');

    // Embedded comma in quoted cell preserved
    expect(result.markdown).toContain('GitHub Actions, lint + test');

    // Blank-row-between-tasks dropped
    expect(result.markdown.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---')).length).toBe(5);
  });
});

describe('spreadsheetToMarkdown — XLSX binary input', () => {
  it('parses an in-memory xlsx workbook', async () => {
    const data = [
      ['Task', 'Owner', 'Due'],
      ['Ship CI', 'Alice', '2026-05-01'],
      ['Cut release', 'Bob', '2026-05-15'],
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Plan');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    const result = await spreadsheetToMarkdown(buf, { fileName: 'plan.xlsx' });
    expect(result.sheetName).toBe('Plan');
    expect(result.rowCount).toBe(2);
    expect(result.columns).toEqual(['Task', 'Owner', 'Due']);
    expect(result.markdown).toMatch(/^# plan\.xlsx — Plan/);
  });

  it('skips a leading empty sheet and picks the first sheet with data', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Blank');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['A', 'B'], [1, 2]]),
      'Real',
    );
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const result = await spreadsheetToMarkdown(buf);
    expect(result.sheetName).toBe('Real');
    expect(result.rowCount).toBe(1);
  });
});

describe('spreadsheetToMarkdown → parseMarkdownIntelligent (end-to-end)', () => {
  it('runs the converted markdown through the prose extractor', async () => {
    const csv = 'Task,Owner,Due\nFinish API,Alice,2026-05-01\nQA pass,Bob,2026-05-08\n';
    const { markdown } = await spreadsheetToMarkdown(csv, { fileName: 'plan.csv' });

    // Mock LLM that the orchestrator will invoke for the prose path.
    const llmClient = {
      model: 'mock-model',
      chat: async () => JSON.stringify({
        projectName: 'Plan',
        projectDescription: '',
        tasks: [
          {
            title: 'Finish API',
            dueDate: '2026-05-01',
            urgency: 6,
            importance: 7,
            difficulty: 4,
            status: 'todo',
            _confidence: 0.85,
          },
          {
            title: 'QA pass',
            dueDate: '2026-05-08',
            urgency: 5,
            importance: 6,
            difficulty: 3,
            status: 'todo',
            _confidence: 0.8,
          },
        ],
      }),
    };

    const result = await parseMarkdownIntelligent(markdown, {
      inputShape: 'prose',
      llmClient,
      sourceLabel: 'plan.csv',
    });

    expect(result.projectName).toBe('Plan');
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].title).toBe('Finish API');
    expect(result.tasks[0].dueDate).toBe('2026-05-01');
    expect(result.tasks[0]._sourcePointer?.source).toBe('plan.csv');
  });
});

describe('__TEST_ONLY__ exports', () => {
  it('re-exports the pure helpers for backwards compatibility', () => {
    expect(__TEST_ONLY__.rowsToMarkdownTable).toBe(rowsToMarkdownTable);
    expect(__TEST_ONLY__.dropBlankRows).toBe(dropBlankRows);
    expect(__TEST_ONLY__.trimTrailingEmptyColumns).toBe(trimTrailingEmptyColumns);
    expect(__TEST_ONLY__.pickSheetName).toBe(pickSheetName);
  });
});
