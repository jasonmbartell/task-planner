/**
 * LLM Prompt Templates
 *
 * Constructs focused prompts for interpreting ambiguous task metadata fields.
 * The LLM only resolves specific fields — it does NOT parse entire markdown.
 */

export const SYSTEM_PROMPT = `You are a task metadata interpreter for a project planner. Given task titles and raw metadata field values that could not be parsed automatically, convert each field to the correct structured value. The current date is provided for resolving relative dates.

Field types and rules (inspired by the Eisenhower Matrix for urgency/importance):
- urgency: integer 1-10 (1 = least urgent, 10 = most urgent). Scale: 1=no time horizon/intern project, 2=no known deadline, 3=due a month+ out, 4=due this month, 5=due this week, 6=due tomorrow, 7=due today but reschedulable, 8=due today with no concrete next-day consequences, 9=due today and could escalate, 10=cannot wait, drop everything. If the text describes time pressure or a deadline, ALSO extract any date into dueDate (or startDate/endDate if a range). If it references another task (e.g. "required before task X"), return: {"type": "dependency", "ref": "<referenced task name>"}
- importance: integer 1-10 (1 = least important, 10 = most important). Use these mappings: "not worth it"/"distraction"/"SWAG" = 1, "fun"/"side project"/"nice to have" = 2, "uncertain impact" = 3, "makes life easier"/"negotiable"/"cosmetic" = 4, "building block"/"subtask dependency" = 5, "key feature"/"information gathering" = 6, "blocks future work"/"enables rollout"/"customer feedback" = 7, "critical"/"hiring"/"IP"/"funding" = 8, "financial penalties"/"major contract" = 9, "existential"/"company formation"/"tax compliance" = 10
- difficulty: integer 1-10 (1 = easiest, 10 = hardest). Scale: 1=done before in an hour, 2=half day with research, 3=one day, 4=one week, 5=one month, 6=couple months, 7=one year, 8=within the year with a team, 9=significant resources and uncertainty, 10=might be impossible. Tasks with difficulty >=5 should ideally be broken into subtasks with difficulty <5.
- dueDate: ISO 8601 date string (YYYY-MM-DD). Extract from any field that mentions a deadline or due date.
- startDate: ISO 8601 date string (YYYY-MM-DD). Extract if a start date is mentioned.
- endDate: ISO 8601 date string (YYYY-MM-DD). Extract if an end date or date range endpoint is mentioned.
- status: one of "todo", "in-progress", "done", "blocked"

IMPORTANT: A single ambiguous field can produce multiple output fields. For example, "urgency: high, due next Friday" should return BOTH an urgency number AND a dueDate. Always extract all information present.

Date inference rules:
- Incomplete dates: "Month-year" (e.g. "June 2026") = due on the 1st of that month. "Month" alone (e.g. "June") = 1st of that month in the current year. "Year" alone (e.g. "2027") = January 1 of that year.
- If urgency is a date, use it as the dueDate and compute urgency from the distance: >1 month out = 3, this month = 4, this week = 5, tomorrow = 6, today = 7, overdue = 8.
- Start/end date inference from difficulty: difficulty 1 = 1 hour, 2 = half day, 3 = 1 day, 4 = 1 week, 5 = 1 month, 6 = couple months, 7 = 1 year. The endDate should default to dueDate minus a 1-day buffer. The startDate should be endDate minus the estimated duration from difficulty.
- If urgency/importance/difficulty fields are completely missing (not just ambiguous text), they default to 1. Only interpret fields that are explicitly present but non-numeric.

Respond with ONLY a valid JSON object mapping task keys to their resolved field values. No explanation, no markdown formatting.

Example — given today is 2026-03-23:
Input:
  Task task_0: "Deploy v2 API"
    - urgency: "critical, must ship by end of month"
  Task task_1: "Write tests"
    - importance: "important for stability"

Output:
{"task_0":{"urgency":9,"dueDate":"2026-03-31"},"task_1":{"importance":7}}`;

/**
 * Build the user prompt for a batch of tasks with ambiguous fields.
 *
 * @param {Array<{taskKey: string, title: string, description: string, ambiguousFields: object}>} tasks
 * @param {string} [referenceDate] - ISO date string for resolving relative dates (defaults to today)
 * @returns {string}
 */
export function buildBatchPrompt(tasks, referenceDate) {
  const today = referenceDate || new Date().toISOString().slice(0, 10);
  const parts = [];

  for (const { taskKey, title, description, ambiguousFields } of tasks) {
    const lines = [`Task ${taskKey}: "${title}"`];
    if (description) {
      lines.push(`  Description: "${description}"`);
    }
    for (const [field, rawValue] of Object.entries(ambiguousFields)) {
      lines.push(`  - ${field}: "${rawValue}"`);
    }
    parts.push(lines.join('\n'));
  }

  return `Today's date: ${today}\n\nInterpret the following ambiguous fields for these tasks:\n\n${parts.join('\n\n')}`;
}

/**
 * Parse the LLM response JSON.
 * Returns a map of taskKey -> { field: resolvedValue, ... } or null on failure.
 */
export function parseResponse(responseText) {
  try {
    // Strip markdown code fences if present
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
