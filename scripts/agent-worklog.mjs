/**
 * agent-worklog — stamp a new dated scaffold entry into CLAUDE_WORKLOG.md.
 *
 * Run: `npm run agent:worklog -- [short-slug] [session-type]`
 *
 *   npm run agent:worklog                         → slug + session placeholders
 *   npm run agent:worklog -- my-friction          → slug filled in
 *   npm run agent:worklog -- my-friction Cowork   → slug + session-type filled
 *
 * The friction log rules (see CLAUDE_WORKLOG.md header) are:
 *   - newest entry at the top of the Entries section
 *   - top-level `##` heading format: `YYYY-MM-DD — short slug — [session type]`
 *   - keep fields terse
 *
 * This script doesn't open an editor (we can't assume one is available); it
 * writes the scaffold to disk and prints the line number so you can jump to
 * it with `code CLAUDE_WORKLOG.md:NN` or similar.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const worklogPath = resolve(repoRoot, 'CLAUDE_WORKLOG.md');

function todayIso() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildScaffold({ date, slug, sessionType }) {
  const slugLabel = slug || '<short-slug>';
  const sessionLabel = sessionType || '<session-type>';
  return [
    `## ${date} — ${slugLabel} — ${sessionLabel}`,
    '',
    '**What I was trying to do:** <one sentence>',
    '',
    '**Where it broke:** <file/line/shape that didn\'t let the op through>',
    '',
    '**Smallest fix that would unblock me:**',
    '- <concrete — field name, validation relaxation, store-action signature>',
    '- <…>',
    '',
    '**Blast radius:** <migrations? views? sync?>',
    '',
    '**Branch / PR:** `claude/agent-<slug>` or "not started"',
    '',
    '**Follow-ups / tests needed:** <anything beyond the fix itself>',
    '',
    '---',
    '',
  ].join('\n');
}

function insertScaffold(body, scaffold) {
  // Find the Entries header. The rule is "newest at the top", so we insert
  // directly after the `## Entries` header (and the blank line that follows).
  const entriesHdr = body.match(/^## Entries\s*\n(?:\s*\n)*/m);
  if (!entriesHdr) {
    throw new Error('CLAUDE_WORKLOG.md: could not find "## Entries" section header.');
  }
  const insertAt = entriesHdr.index + entriesHdr[0].length;
  const before = body.slice(0, insertAt);
  const after = body.slice(insertAt);
  const next = `${before}${scaffold}${after}`;
  const newEntryLine = before.split('\n').length; // 1-indexed line of the inserted heading
  return { next, newEntryLine };
}

function parseArgs(argv) {
  // argv[0], argv[1] are node + script; rest are caller-supplied.
  const [slug = '', sessionType = ''] = argv.slice(2);
  return { slug, sessionType };
}

function main() {
  const { slug, sessionType } = parseArgs(process.argv);
  const date = todayIso();

  let body;
  try {
    body = readFileSync(worklogPath, 'utf8');
  } catch (err) {
    console.error(`[agent:worklog] cannot read ${worklogPath}: ${err.message}`);
    process.exit(1);
  }

  const scaffold = buildScaffold({ date, slug, sessionType });
  let next, newEntryLine;
  try {
    ({ next, newEntryLine } = insertScaffold(body, scaffold));
  } catch (err) {
    console.error(`[agent:worklog] ${err.message}`);
    process.exit(1);
  }

  writeFileSync(worklogPath, next, 'utf8');
  console.log(`[agent:worklog] inserted ${date} entry at CLAUDE_WORKLOG.md:${newEntryLine}`);
  console.log(`[agent:worklog] open:  code CLAUDE_WORKLOG.md:${newEntryLine}`);
}

// Run when invoked as the main module.
const invoked = resolve(process.argv[1] || '');
const selfPath = fileURLToPath(import.meta.url);
if (invoked === selfPath) {
  main();
}

export { buildScaffold, insertScaffold, todayIso };
