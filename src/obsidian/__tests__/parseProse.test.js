import { describe, it, expect, vi } from 'vitest';
import {
  parseProse,
  chunkForExtraction,
  dedupCandidates,
  __TEST_ONLY__,
} from '../parseProse.js';
import { ProseIngestionNoLlmError } from '../errors.js';

const { parseExtractionResponse, normalizeCandidate, truncateForSource } = __TEST_ONLY__;

// Minimal LLMClient stub — parseProse only calls .chat() and reads .model.
// Calls past the queued responses return an empty {tasks:[]} so tests don't
// have to engineer exact chunk counts when forcing multi-chunk runs.
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

const BRAIN_DUMP = `Need to finish the investor deck by next Friday — slides 3 and 7 still blank. Also the pricing page copy is overdue, should have shipped it last week.`;

const SINGLE_TASK_RESPONSE = {
  projectName: 'Fundraising',
  projectDescription: 'Round-close prep',
  tasks: [
    {
      title: 'Finish investor deck',
      description: 'Slides 3 and 7 still blank',
      dueDate: '2026-05-01',
      urgency: 8,
      importance: 9,
      difficulty: 4,
      status: 'in-progress',
      _confidence: 0.9,
      _dependencyRefs: [],
    },
  ],
};

describe('parseProse', () => {
  it('throws ProseIngestionNoLlmError without an LLM client', async () => {
    await expect(parseProse('hello', {})).rejects.toBeInstanceOf(ProseIngestionNoLlmError);
  });

  it('returns the contract shape with extraction metadata', async () => {
    const llm = makeLLM([SINGLE_TASK_RESPONSE]);
    const result = await parseProse(BRAIN_DUMP, {
      llmClient: llm,
      sourceLabel: 'pasted-text',
    });

    expect(result.projectName).toBe('Fundraising');
    expect(result.projectDescription).toBe('Round-close prep');
    expect(result.sprints).toEqual([]);
    expect(result.tasks).toHaveLength(1);
    expect(result._extraction).toMatchObject({
      model: 'mock-model',
      chunkCount: 1,
    });
    expect(result._extraction.wallMs).toBeGreaterThanOrEqual(0);
    expect(result._extraction.tokensUsed).toBeGreaterThan(0);
  });

  it('normalizes tasks: id, defaults, clamping, dependency refs, source pointer', async () => {
    const llm = makeLLM([
      {
        projectName: null,
        projectDescription: null,
        tasks: [
          {
            title: '  Ship pricing page  ',
            urgency: 12,          // out of range → clamped to 10
            importance: 0,         // out of range → clamped to 1
            difficulty: 3.6,       // float → rounds to 4
            status: 'IN-PROGRESS', // case-insensitive
            _confidence: 2.5,      // clamped to 1
            _dependencyRefs: ['Finish investor deck', '', '  '],
          },
        ],
      },
    ]);
    const result = await parseProse(BRAIN_DUMP, { llmClient: llm, sourceLabel: 'pasted-text' });

    expect(result.tasks).toHaveLength(1);
    const t = result.tasks[0];

    expect(t.id).toMatch(/^task-/);
    expect(t.title).toBe('Ship pricing page');
    expect(t.urgency).toBe(10);
    expect(t.importance).toBe(1);
    expect(t.difficulty).toBe(4);
    expect(t.status).toBe('in-progress');
    expect(t._confidence).toBe(1);
    expect(t._dependencyRefs).toEqual(['Finish investor deck']);

    // Defaults carried forward to the orchestrator's stages 4–7:
    expect(t.startDate).toBe('');
    expect(t.endDate).toBe('');
    expect(t.dueDate).toBe('');
    expect(t.dependencies).toEqual([]);
    expect(t._ambiguousFields).toEqual({});
    expect(t._subtasks).toEqual([]);
    expect(t.parentTaskId).toBeNull();
    expect(t._sprintName).toBe('Inbox');

    // Source pointer (chunk-scoped for v1).
    expect(t._sourcePointer.source).toBe('pasted-text');
    expect(t._sourcePointer.lineStart).toBe(1);
    expect(t._sourcePointer.lineEnd).toBe(1);
    expect(t._sourcePointer.rawText).toBe(BRAIN_DUMP);
  });

  it('drops tasks with missing / empty titles', async () => {
    const llm = makeLLM([
      {
        projectName: null,
        tasks: [
          { title: 'Keep me', _confidence: 0.9 },
          { title: '   ', _confidence: 0.9 },
          { description: 'no title field', _confidence: 0.9 },
          null,
          'not-an-object',
        ],
      },
    ]);
    const result = await parseProse('x', { llmClient: llm });
    expect(result.tasks.map((t) => t.title)).toEqual(['Keep me']);
  });

  it('falls back to fileName when the LLM returns no projectName', async () => {
    const llm = makeLLM([{ projectName: null, tasks: [{ title: 'Thing', _confidence: 0.8 }] }]);
    const result = await parseProse('x', { llmClient: llm, fileName: 'meeting-notes.md' });
    expect(result.projectName).toBe('meeting-notes.md');
  });

  it('falls back to "Untitled" when neither projectName nor fileName is given', async () => {
    const llm = makeLLM([{ tasks: [{ title: 'Thing', _confidence: 0.8 }] }]);
    const result = await parseProse('x', { llmClient: llm });
    expect(result.projectName).toBe('Untitled');
  });

  it('dedups across chunks by lowercased title, keeping highest _confidence', async () => {
    // Force two chunks by using a small chunkTokenBudget.
    const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n');
    const llm = makeLLM([
      { tasks: [{ title: 'Duplicate', _confidence: 0.4 }, { title: 'Only-in-chunk-1', _confidence: 0.9 }] },
      { tasks: [{ title: 'duplicate', _confidence: 0.95 }, { title: 'Only-in-chunk-2', _confidence: 0.7 }] },
    ]);

    const result = await parseProse(content, {
      llmClient: llm,
      chunkTokenBudget: 200,  // ~800 chars → forces multi-chunk
      chunkOverlapTokens: 20,
    });

    expect(llm.chat.mock.calls.length).toBeGreaterThan(1);
    expect(result._extraction.chunkCount).toBeGreaterThan(1);

    const titles = result.tasks.map((t) => t.title).sort();
    expect(titles).toEqual(['Only-in-chunk-1', 'Only-in-chunk-2', 'duplicate']);

    const dup = result.tasks.find((t) => t.title.toLowerCase() === 'duplicate');
    expect(dup._confidence).toBe(0.95);
  });

  it('skips chunks whose LLM response is malformed JSON', async () => {
    const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n');
    const llm = makeLLM([
      'not json at all',
      { tasks: [{ title: 'Survivor', _confidence: 0.8 }] },
    ]);

    const result = await parseProse(content, {
      llmClient: llm,
      chunkTokenBudget: 200,
      chunkOverlapTokens: 20,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Survivor');
  });

  it('honors AbortSignal before firing the LLM call', async () => {
    const llm = makeLLM([SINGLE_TASK_RESPONSE]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      parseProse(BRAIN_DUMP, { llmClient: llm, signal: ctrl.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('propagates LLM errors (network, auth, etc) to the caller', async () => {
    const boom = Object.assign(new Error('boom'), { status: 401 });
    const llm = makeLLM([boom]);
    await expect(parseProse(BRAIN_DUMP, { llmClient: llm })).rejects.toThrow('boom');
  });

  it('returns an empty task list when input is empty', async () => {
    const llm = makeLLM([]);
    const result = await parseProse('', { llmClient: llm });
    expect(result.tasks).toEqual([]);
    expect(result._extraction.chunkCount).toBe(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });
});

describe('chunkForExtraction', () => {
  it('returns [] for empty or non-string input', () => {
    expect(chunkForExtraction('')).toEqual([]);
    expect(chunkForExtraction(null)).toEqual([]);
    expect(chunkForExtraction(undefined)).toEqual([]);
  });

  it('returns one chunk when content fits the budget', () => {
    const content = 'line 1\nline 2\nline 3';
    const chunks = chunkForExtraction(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ text: content, lineStart: 1, lineEnd: 3 });
  });

  it('splits into overlapping chunks with monotonic 1-indexed line ranges', () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkForExtraction(content, { chunkTokenBudget: 200, chunkOverlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);

    // First chunk starts at line 1, last chunk ends at line 200.
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[chunks.length - 1].lineEnd).toBe(200);

    // Every chunk's range is well-formed and chunks advance forward.
    let prevStart = 0;
    for (const c of chunks) {
      expect(c.lineStart).toBeGreaterThan(prevStart);
      expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart);
      prevStart = c.lineStart;
    }

    // Overlap exists: the last line of chunk i-1 should appear in chunk i's
    // text for at least one pairing.
    const hasOverlap = chunks.slice(1).some((c, i) => {
      const prev = chunks[i];
      return prev.lineEnd >= c.lineStart;
    });
    expect(hasOverlap).toBe(true);
  });
});

describe('dedupCandidates', () => {
  it('keeps the highest-confidence copy per lowercased title', () => {
    const out = dedupCandidates([
      { title: 'A', _confidence: 0.4 },
      { title: 'a', _confidence: 0.9 },
      { title: 'B', _confidence: 0.7 },
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((t) => t.title.toLowerCase() === 'a');
    expect(a._confidence).toBe(0.9);
  });

  it('drops entries with missing titles', () => {
    const out = dedupCandidates([
      { title: '', _confidence: 0.9 },
      { _confidence: 0.9 },
      { title: 'Kept', _confidence: 0.1 },
    ]);
    expect(out.map((t) => t.title)).toEqual(['Kept']);
  });

  it('treats missing _confidence as 0 for tie-breaks', () => {
    const out = dedupCandidates([
      { title: 'X' },
      { title: 'x', _confidence: 0.01 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]._confidence).toBe(0.01);
  });
});

describe('parseExtractionResponse', () => {
  it('parses plain JSON', () => {
    expect(parseExtractionResponse('{"tasks":[]}')).toEqual({ tasks: [] });
  });

  it('strips ```json fences', () => {
    const fenced = '```json\n{"tasks":[{"title":"X"}]}\n```';
    expect(parseExtractionResponse(fenced)).toEqual({ tasks: [{ title: 'X' }] });
  });

  it('extracts outermost object when wrapped in commentary', () => {
    const text = 'Here you go:\n{"tasks":[{"title":"X"}]}\nLet me know.';
    expect(parseExtractionResponse(text)).toEqual({ tasks: [{ title: 'X' }] });
  });

  it('returns null for unparseable junk', () => {
    expect(parseExtractionResponse('nope')).toBeNull();
    expect(parseExtractionResponse('')).toBeNull();
    expect(parseExtractionResponse(null)).toBeNull();
  });
});

describe('normalizeCandidate', () => {
  const meta = { source: 'src', lineStart: 5, lineEnd: 12, rawText: 'raw' };

  it('returns null for non-object or titleless input', () => {
    expect(normalizeCandidate(null, meta)).toBeNull();
    expect(normalizeCandidate({ title: '' }, meta)).toBeNull();
    expect(normalizeCandidate({ title: '   ' }, meta)).toBeNull();
  });

  it('coerces non-numeric urgency/importance/difficulty to null', () => {
    const t = normalizeCandidate({ title: 'T', urgency: 'high', importance: null, difficulty: 'M' }, meta);
    expect(t.urgency).toBeNull();
    expect(t.importance).toBeNull();
    expect(t.difficulty).toBeNull();
  });

  it('defaults _confidence to 0.5 when missing', () => {
    const t = normalizeCandidate({ title: 'T' }, meta);
    expect(t._confidence).toBe(0.5);
  });

  it('defaults status to "todo" for unknown values', () => {
    expect(normalizeCandidate({ title: 'T', status: 'wat' }, meta).status).toBe('todo');
    expect(normalizeCandidate({ title: 'T' }, meta).status).toBe('todo');
  });
});

describe('truncateForSource', () => {
  it('returns short strings unchanged', () => {
    expect(truncateForSource('abc')).toBe('abc');
  });

  it('truncates with ellipsis past 512 chars', () => {
    const big = 'a'.repeat(600);
    const out = truncateForSource(big);
    expect(out.length).toBe(512);
    expect(out.endsWith('…')).toBe(true);
  });
});
