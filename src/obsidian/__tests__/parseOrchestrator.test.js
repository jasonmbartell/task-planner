/**
 * parseMarkdownIntelligent + detectInputShape
 *
 * M-P2 coverage: the orchestrator's shape-resolution branch (structured /
 * prose / auto), the routing to parseProse vs. parseMarkdownFile, and the
 * ProseIngestionNoLlmError guard. The downstream stages (flatten, date
 * infer, dep resolve) are exercised indirectly via their observable effect
 * on the returned task shape, not re-tested here — parseDeterministic.test
 * covers them on the structured side and parseProse.test covers them on the
 * prose side.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseMarkdownIntelligent, detectInputShape } from '../parseOrchestrator.js';
import { ProseIngestionNoLlmError } from '../errors.js';
import * as parseProseModule from '../parseProse.js';

// Minimal LLMClient stub — parseProse only calls .chat() and reads .model.
function makeLLM(responses, { model = 'mock-model' } = {}) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const chat = vi.fn(async () => {
    if (queue.length === 0) return '{"tasks":[]}';
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'string' ? next : JSON.stringify(next);
  });
  return { chat, model };
}

const PROSE = `Need to finish the investor deck by next Friday — slides 3 and 7 still blank. Also the pricing page copy is overdue, should have shipped it last week.`;

const STRUCTURED_CHECKBOX = `## Project: MyProj\n\n- [ ] Ship thing | id:task-abc12345 | urg:5 | imp:5 | diff:3`;

const STRUCTURED_METADATA = `- [ ] Finish deck — description goes here
    - Urgency: 7
    - Importance: 8
    - Difficulty: 3`;

const STRUCTURED_PIPE = `| Task | Urgency | Importance |\n|------|---------|------------|\n| Write tests | 5 | 5 |`;

describe('detectInputShape', () => {
  it('returns "markdown" for empty / non-string input', () => {
    expect(detectInputShape('')).toBe('markdown');
    expect(detectInputShape('   \n  ')).toBe('markdown');
    expect(detectInputShape(null)).toBe('markdown');
    expect(detectInputShape(undefined)).toBe('markdown');
    expect(detectInputShape(42)).toBe('markdown');
  });

  it('detects checkbox subtasks as markdown', () => {
    expect(detectInputShape('- [ ] do the thing')).toBe('markdown');
    expect(detectInputShape('- [x] done already')).toBe('markdown');
    expect(detectInputShape('- [X] done with caps')).toBe('markdown');
  });

  it('detects "## Task:" metadata block header as markdown', () => {
    expect(detectInputShape('## Task: thing\nstuff')).toBe('markdown');
  });

  it('detects pipe-delimited rows as markdown', () => {
    expect(detectInputShape('| Title | Urgency |\n| A | 5 |')).toBe('markdown');
  });

  it('classifies plain prose without markers as prose', () => {
    expect(detectInputShape(PROSE)).toBe('prose');
    expect(detectInputShape('One short idea.')).toBe('prose');
  });

  it('classifies mixed input (prose + one structured marker) as markdown', () => {
    const mixed = `Some background paragraph that talks about the project.\n\n- [ ] actual checkbox task`;
    expect(detectInputShape(mixed)).toBe('markdown');
  });

  it('does not misclassify bullet lists without checkboxes as markdown', () => {
    // Plain `- foo` without the `[ ]` is prose territory — the extractor is
    // allowed to pull tasks out of bullet-list brain dumps.
    const bullets = `- idea one\n- idea two\n- idea three`;
    expect(detectInputShape(bullets)).toBe('prose');
  });
});

describe('parseMarkdownIntelligent — routing', () => {
  it('defaults to the structured path when inputShape is omitted', async () => {
    const spy = vi.spyOn(parseProseModule, 'parseProse');
    // Plain prose with NO structured markers — still routed to the
    // deterministic parser because the default shape is 'markdown', NOT
    // auto. This guarantees a caller that hands us a .md file does NOT
    // silently fire LLM calls.
    const result = await parseMarkdownIntelligent(PROSE, { fileName: 'notes.md' });

    expect(spy).not.toHaveBeenCalled();
    expect(Array.isArray(result.tasks)).toBe(true);
    // Deterministic parser produces zero tasks from unstructured prose.
    expect(result.tasks).toHaveLength(0);
    spy.mockRestore();
  });

  it('defaults to markdown even when an LLM client is configured', async () => {
    const spy = vi.spyOn(parseProseModule, 'parseProse');
    const llm = makeLLM([{ tasks: [{ title: 'Should not appear' }] }]);
    const result = await parseMarkdownIntelligent(PROSE, { llmClient: llm, fileName: 'notes.md' });

    expect(spy).not.toHaveBeenCalled();
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.tasks).toHaveLength(0);
    spy.mockRestore();
  });

  it('routes structured content through the deterministic parser', async () => {
    const spy = vi.spyOn(parseProseModule, 'parseProse');
    const result = await parseMarkdownIntelligent(STRUCTURED_METADATA, { inputShape: 'structured' });

    expect(spy).not.toHaveBeenCalled();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Finish deck');
    expect(result.tasks[0].urgency).toBe(7);
    expect(result.tasks[0].importance).toBe(8);
    expect(result.tasks[0].difficulty).toBe(3);
    spy.mockRestore();
  });

  it('routes prose content through parseProse when inputShape="prose"', async () => {
    const llm = makeLLM([
      {
        projectName: 'Fundraising',
        tasks: [
          { title: 'Finish investor deck', _confidence: 0.9, dueDate: '2026-05-01' },
        ],
      },
    ]);
    const result = await parseMarkdownIntelligent(PROSE, {
      inputShape: 'prose',
      llmClient: llm,
      sourceLabel: 'pasted-text',
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.projectName).toBe('Fundraising');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Finish investor deck');
    // Source pointer threaded through from parseProse.
    expect(result.tasks[0]._sourcePointer).toMatchObject({
      source: 'pasted-text',
      lineStart: 1,
    });
    // Stage 5 defaults: null urgency/importance/difficulty coerced to 1.
    expect(result.tasks[0].urgency).toBe(1);
    expect(result.tasks[0].importance).toBe(1);
    expect(result.tasks[0].difficulty).toBe(1);
    // Stage 6 date inference: dueDate present + difficulty=1 → startDate/endDate inferred.
    expect(result.tasks[0].startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.tasks[0].endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('auto mode routes structured content to the deterministic parser', async () => {
    const spy = vi.spyOn(parseProseModule, 'parseProse');
    const llm = makeLLM([]);
    const result = await parseMarkdownIntelligent(STRUCTURED_CHECKBOX, {
      inputShape: 'auto',
      llmClient: llm,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Ship thing');
    spy.mockRestore();
  });

  it('auto mode routes pure prose to parseProse', async () => {
    const llm = makeLLM([
      { tasks: [{ title: 'Extracted from prose', _confidence: 0.8 }] },
    ]);
    const result = await parseMarkdownIntelligent(PROSE, {
      inputShape: 'auto',
      llmClient: llm,
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Extracted from prose');
  });

  it('auto mode on structured pipe content stays on the deterministic path', async () => {
    const spy = vi.spyOn(parseProseModule, 'parseProse');
    const result = await parseMarkdownIntelligent(STRUCTURED_PIPE, {
      inputShape: 'auto',
      llmClient: makeLLM([]),
    });

    expect(spy).not.toHaveBeenCalled();
    // Deterministic parser handles pipe format; exact task count isn't
    // the point here — the point is that we didn't fall through to prose.
    expect(Array.isArray(result.tasks)).toBe(true);
    spy.mockRestore();
  });

  it('unknown inputShape value falls back to markdown (defensive)', async () => {
    const spy = vi.spyOn(parseProseModule, 'parseProse');
    const result = await parseMarkdownIntelligent(PROSE, {
      inputShape: 'totally-made-up',
      llmClient: makeLLM([]),
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.tasks).toHaveLength(0);
    spy.mockRestore();
  });

  it('throws ProseIngestionNoLlmError when prose path has no llmClient (explicit "prose")', async () => {
    await expect(
      parseMarkdownIntelligent(PROSE, { inputShape: 'prose' })
    ).rejects.toBeInstanceOf(ProseIngestionNoLlmError);
  });

  it('throws ProseIngestionNoLlmError when prose path has null llmClient (explicit "prose")', async () => {
    await expect(
      parseMarkdownIntelligent(PROSE, { inputShape: 'prose', llmClient: null })
    ).rejects.toBeInstanceOf(ProseIngestionNoLlmError);
  });

  it('throws ProseIngestionNoLlmError when auto resolves to prose without an llmClient', async () => {
    await expect(
      parseMarkdownIntelligent(PROSE, { inputShape: 'auto' })
    ).rejects.toBeInstanceOf(ProseIngestionNoLlmError);
  });

  it('auto mode with no llmClient still succeeds when content resolves to markdown', async () => {
    // No llmClient configured — this is fine because detection picks
    // 'markdown' and the deterministic parser is LLM-free.
    const result = await parseMarkdownIntelligent(STRUCTURED_METADATA, { inputShape: 'auto' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Finish deck');
  });

  it('threads sourceLabel + fileName into the prose path', async () => {
    const llm = makeLLM([
      { tasks: [{ title: 'Pick fixture label test', _confidence: 0.6 }] },
    ]);
    const result = await parseMarkdownIntelligent('a paragraph of text', {
      inputShape: 'prose',
      llmClient: llm,
      fileName: 'transcript.md',
      sourceLabel: 'cowork-2026-04-21',
    });

    expect(result.tasks[0]._sourcePointer.source).toBe('cowork-2026-04-21');
    // No projectName from the LLM → falls back to fileName.
    expect(result.projectName).toBe('transcript.md');
  });

  it('prose-path tasks have empty _ambiguousFields so Stage 2 is a no-op', async () => {
    const llm = makeLLM([
      { tasks: [{ title: 'No ambiguous fields here', _confidence: 0.8 }] },
    ]);
    const result = await parseMarkdownIntelligent(PROSE, {
      inputShape: 'prose',
      llmClient: llm,
    });

    // parseProse seeds _ambiguousFields as {} and Stage 2 is a no-op when
    // nothing is ambiguous — only one LLM call fires (extraction), not a
    // second round of interpretation.
    expect(result.tasks[0]._ambiguousFields).toEqual({});
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });
});
