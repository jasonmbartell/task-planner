/**
 * Unit tests for scripts/agent-worklog.mjs — the scaffold insertion logic is
 * pure (string-in → string-out), so we drive it directly and never touch disk.
 */

import { describe, it, expect } from 'vitest';
import { buildScaffold, insertScaffold, todayIso } from '../agent-worklog.mjs';

const FIXTURE = `# CLAUDE_WORKLOG

intro text.

---

## Format

format description.

---

## Entries

## 2026-04-22 — prior entry — Cowork session

body.

---

<!-- New entries go ABOVE this line, newest first. -->
`;

describe('buildScaffold', () => {
  it('stamps the date and placeholders when fields are omitted', () => {
    const out = buildScaffold({ date: '2026-04-23', slug: '', sessionType: '' });
    expect(out).toMatch(/^## 2026-04-23 — <short-slug> — <session-type>$/m);
    expect(out).toMatch(/\*\*What I was trying to do:\*\*/);
    expect(out).toMatch(/\*\*Blast radius:\*\*/);
    expect(out).toMatch(/\*\*Branch \/ PR:\*\*/);
    expect(out).toMatch(/\n---\n$/);
  });

  it('fills in slug + session-type when supplied', () => {
    const out = buildScaffold({ date: '2026-04-23', slug: 'typed-edges-redux', sessionType: 'Claude Code' });
    expect(out).toMatch(/^## 2026-04-23 — typed-edges-redux — Claude Code$/m);
  });
});

describe('insertScaffold', () => {
  it('places the new entry directly under the Entries header', () => {
    const scaffold = buildScaffold({ date: '2026-04-23', slug: 'test', sessionType: 'Claude Code' });
    const { next, newEntryLine } = insertScaffold(FIXTURE, scaffold);

    // The Entries header should still be there.
    expect(next).toMatch(/^## Entries\s*$/m);

    // The new entry heading should appear BEFORE the prior entry.
    const newIdx = next.indexOf('## 2026-04-23 — test — Claude Code');
    const priorIdx = next.indexOf('## 2026-04-22 — prior entry — Cowork session');
    expect(newIdx).toBeGreaterThan(-1);
    expect(priorIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(priorIdx);

    // The reported line number should point at the new heading.
    const linesToNew = next.split('\n').slice(0, newEntryLine);
    expect(linesToNew[newEntryLine - 1]).toMatch(/^## 2026-04-23 /);
  });

  it('throws if the Entries section header is missing', () => {
    const scaffold = buildScaffold({ date: '2026-04-23', slug: 'x', sessionType: 'y' });
    const broken = FIXTURE.replace('## Entries', '## NotEntries');
    expect(() => insertScaffold(broken, scaffold)).toThrow(/Entries/);
  });
});

describe('todayIso', () => {
  it('returns a YYYY-MM-DD string', () => {
    const s = todayIso();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
