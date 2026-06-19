/**
 * Prose Extraction Prompt
 *
 * System prompt + few-shot examples for turning free-form text (prose,
 * transcripts, markdown tables derived from ad-hoc spreadsheets) into
 * candidate tasks.
 *
 * NOT the same as llmPrompts.js — that one *interprets* ambiguous field
 * values on tasks the deterministic parser already identified. This prompt
 * does *extraction*: it draws task boundaries where none exist in the input.
 *
 * See docs/prose-ingestion.md §7 for the design and the rules the prompt
 * must enforce. This file is the first thing to tune when extraction
 * quality regresses — run scripts/prose-eval.mjs (future, M-P6) against the
 * held-out fixture set before and after any edit.
 */

/**
 * System prompt. Imperative, short enough to leave room for a ~6k-token user
 * chunk on a 200k context model.
 */
export const PROSE_SYSTEM_PROMPT = `You are a task extractor for a solo founder's planning tool. Read the input text and return a JSON object describing candidate tasks extracted from it.

The input is one of:
  - free-form prose (brain-dump, meeting notes, paragraph)
  - a transcript of a conversation (possibly with speaker tags)
  - a markdown table converted from an ad-hoc spreadsheet (each data row is probably one task; column headers are hints, not a fixed schema)

Return shape (strict JSON, no prose wrapper, no markdown code fence):
{
  "projectName": string | null,
  "projectDescription": string | null,
  "tasks": [
    {
      "title": string,             // 3–80 chars, imperative mood ("Ship CI pipeline")
      "description": string | null,
      "dueDate": "YYYY-MM-DD" | null,
      "urgency": integer 1..10 | null,
      "importance": integer 1..10 | null,
      "difficulty": integer 1..10 | null,
      "status": "todo" | "in-progress" | "done" | "blocked" | null,
      "_confidence": number 0..1,  // how sure you are this is a real discrete task
      "_dependencyRefs": [string]  // titles this task blocks-on, extracted from in-text language like "after we finish X"
    },
    ...
  ]
}

Rules:
  1. DO NOT invent tasks from vague statements. "We should think about X" is not a task unless there is a concrete next action.
  2. Prefer multiple small tasks over one vague one, but keep _confidence low on speculative splits.
  3. For markdown-table input, each data row is probably one task. Map headers to fields sensibly:
     - "task" / "action" / "what" / "deliverable" / "TODO" / "description" → title
     - "due" / "deadline" / "by when" / "target date" / "when" → dueDate (ISO)
     - "priority" / "urgency" / "P0/P1/P2" → urgency (P0=9, P1=7, P2=5, P3=3)
     - "effort" / "size" / "t-shirt" → difficulty (S=2, M=4, L=6, XL=8)
     - "importance" / "impact" / "why" → importance
     - "status" / "state" → status
     - Unlabeled first column → title.
     Skip rows that obviously aren't tasks (separators, totals, blank titles).
  4. NEVER set urgency / importance / difficulty unless you have strong textual evidence. Omit (null) rather than guess.
  5. projectName: infer from input subject matter. Use null if unclear.
  6. Reply with JSON ONLY. No preamble, no postamble, no code fence. If input is empty or contains no tasks, return {"projectName": null, "projectDescription": null, "tasks": []}.`;

/**
 * Few-shot examples. Kept short so they don't eat context budget when
 * stacked with a large user chunk. Each example is {input, output} where
 * output is the exact JSON the model should produce.
 *
 * TODO (M-P1): pick 3 examples that cover the coverage gaps the eval set
 * reveals. Draft set below is a starting point.
 */
export const PROSE_FEW_SHOT_EXAMPLES = [
  {
    label: 'brain-dump-paragraph',
    input: `Need to finish the investor deck by next Friday — slides 3 and 7 still blank. Also the pricing page copy is overdue, should have shipped it last week. If I have time, poke at the onboarding email flow but that's low priority.`,
    output: {
      projectName: null,
      projectDescription: null,
      tasks: [
        {
          title: 'Finish investor deck (slides 3 and 7)',
          description: 'Slides 3 and 7 still blank.',
          dueDate: null,
          urgency: 8,
          importance: null,
          difficulty: null,
          status: 'in-progress',
          _confidence: 0.9,
          _dependencyRefs: [],
        },
        {
          title: 'Ship pricing page copy',
          description: 'Overdue — should have shipped last week.',
          dueDate: null,
          urgency: 9,
          importance: null,
          difficulty: null,
          status: null,
          _confidence: 0.85,
          _dependencyRefs: [],
        },
        {
          title: 'Review onboarding email flow',
          description: "If time permits; marked low priority.",
          dueDate: null,
          urgency: 2,
          importance: null,
          difficulty: null,
          status: null,
          _confidence: 0.55,
          _dependencyRefs: [],
        },
      ],
    },
  },

  {
    label: 'markdown-table-ad-hoc',
    input: `| What | By when | Priority | Notes |
|------|---------|----------|-------|
| Migrate auth to PKCE | 2026-05-15 | P1 | blocks marketplace launch |
| Write migration runbook | | P2 | after auth migration is done |
| Quarterly board memo | 2026-05-01 | P0 | |`,
    output: {
      projectName: null,
      projectDescription: null,
      tasks: [
        {
          title: 'Migrate auth to PKCE',
          description: 'Blocks marketplace launch.',
          dueDate: '2026-05-15',
          urgency: 7,
          importance: null,
          difficulty: null,
          status: null,
          _confidence: 0.95,
          _dependencyRefs: [],
        },
        {
          title: 'Write migration runbook',
          description: null,
          dueDate: null,
          urgency: 5,
          importance: null,
          difficulty: null,
          status: null,
          _confidence: 0.9,
          _dependencyRefs: ['Migrate auth to PKCE'],
        },
        {
          title: 'Quarterly board memo',
          description: null,
          dueDate: '2026-05-01',
          urgency: 9,
          importance: null,
          difficulty: null,
          status: null,
          _confidence: 0.95,
          _dependencyRefs: [],
        },
      ],
    },
  },

  {
    label: 'meeting-transcript-fragment',
    input: `Sam: so the big thing is we need to pick a payments vendor for the checkout flow.
Riley: right, and the deadline for that decision is June 1.
Sam: yeah. I'll draft the integration spec this week and send it to you for review.
Riley: cool. I'll collect the last three vendor quotes before Friday.`,
    output: {
      projectName: null,
      projectDescription: null,
      tasks: [
        {
          title: 'Pick payments vendor for checkout',
          description: 'Decision deadline June 1.',
          dueDate: '2026-06-01',
          urgency: null,
          importance: null,
          difficulty: null,
          status: null,
          _confidence: 0.85,
          _dependencyRefs: ['Draft payments integration spec', 'Collect vendor quotes'],
        },
        {
          title: 'Draft payments integration spec',
          description: 'Send to Riley for review.',
          dueDate: null,
          urgency: null,
          importance: null,
          difficulty: null,
          status: null,
          _confidence: 0.9,
          _dependencyRefs: [],
        },
        {
          title: 'Collect vendor quotes',
          description: 'Last three, before Friday.',
          dueDate: null,
          urgency: null,
          importance: null,
          difficulty: null,
          status: null,
          _confidence: 0.9,
          _dependencyRefs: [],
        },
      ],
    },
  },
];

/**
 * Build the full user-prompt block: few-shot examples followed by the real
 * input. Output is a single string the caller hands to `LLMClient.chat()`
 * as the user message (system message = PROSE_SYSTEM_PROMPT).
 *
 * The real input is delimited with a fenced marker so a malformed chunk
 * boundary doesn't cause the model to read instructions out of the data.
 *
 * @param {string} content - Raw input text (prose or markdown-from-xlsx).
 * @param {object} [opts]
 * @param {string} [opts.sourceLabel] - Tag surfaced to the model so it can
 *   include it in error context if asked.
 * @returns {string}
 */
export function buildProseUserPrompt(content, { sourceLabel } = {}) {
  const lines = [];
  lines.push('Here are examples of valid extractions. Match this shape and style.');
  lines.push('');

  for (const example of PROSE_FEW_SHOT_EXAMPLES) {
    lines.push(`--- EXAMPLE: ${example.label} ---`);
    lines.push('INPUT:');
    lines.push(example.input);
    lines.push('OUTPUT:');
    lines.push(JSON.stringify(example.output, null, 2));
    lines.push('');
  }

  lines.push('--- REAL INPUT ---');
  if (sourceLabel) lines.push(`Source: ${sourceLabel}`);
  lines.push('<<<INPUT');
  lines.push(content);
  lines.push('INPUT>>>');
  lines.push('');
  lines.push('Reply with JSON only.');

  return lines.join('\n');
}
