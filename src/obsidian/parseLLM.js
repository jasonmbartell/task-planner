/**
 * LLM Field Interpreter
 *
 * Takes tasks with _ambiguousFields from the deterministic parser
 * and uses an LLM to resolve them into structured values.
 */

import { SYSTEM_PROMPT, buildBatchPrompt, parseResponse } from './llmPrompts.js';

const MAX_BATCH_SIZE = 20;

/**
 * Interpret ambiguous fields using an LLM.
 *
 * @param {Array} tasks - Parsed tasks with _ambiguousFields
 * @param {import('./llmClient.js').LLMClient} llmClient - Configured LLM client
 * @returns {Promise<void>} Mutates tasks in place with resolved values
 */
export async function interpretAmbiguousFields(tasks, llmClient) {
  // Collect tasks that have ambiguous fields
  const ambiguousTasks = [];
  const taskIndexMap = new Map(); // taskKey -> original task reference

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task._ambiguousFields && Object.keys(task._ambiguousFields).length > 0) {
      const taskKey = `task_${ambiguousTasks.length}`;
      ambiguousTasks.push({
        taskKey,
        title: task.title,
        description: task.description || '',
        ambiguousFields: task._ambiguousFields,
      });
      taskIndexMap.set(taskKey, task);
    }
  }

  if (ambiguousTasks.length === 0) return;

  // Process in batches
  for (let start = 0; start < ambiguousTasks.length; start += MAX_BATCH_SIZE) {
    const batch = ambiguousTasks.slice(start, start + MAX_BATCH_SIZE);

    try {
      const userPrompt = buildBatchPrompt(batch);
      const responseText = await llmClient.chat(SYSTEM_PROMPT, userPrompt);
      const parsed = parseResponse(responseText);

      if (!parsed) {
        // Retry once with the same prompt
        const retryText = await llmClient.chat(SYSTEM_PROMPT, userPrompt);
        const retryParsed = parseResponse(retryText);
        if (retryParsed) {
          applyInterpretations(retryParsed, taskIndexMap);
        } else {
          applyDefaults(batch, taskIndexMap);
        }
        continue;
      }

      applyInterpretations(parsed, taskIndexMap);
    } catch (err) {
      console.warn('[obsidian/parseLLM] LLM interpretation failed:', err.message);
      applyDefaults(batch, taskIndexMap);
    }
  }
}

/**
 * Apply LLM interpretations back to the tasks.
 */
function applyInterpretations(parsed, taskIndexMap) {
  for (const [taskKey, fields] of Object.entries(parsed)) {
    const task = taskIndexMap.get(taskKey);
    if (!task) continue;

    for (const [field, value] of Object.entries(fields)) {
      if (field === 'urgency' && typeof value === 'object' && value?.type === 'dependency') {
        // Dependency reference — store for resolution in orchestrator
        if (!task._dependencyRefs) task._dependencyRefs = [];
        task._dependencyRefs.push(value.ref);
        // Set a reasonable default urgency for referenced tasks
        task.urgency = task.urgency ?? 2;
      } else if (field === 'urgency' && typeof value === 'number') {
        task.urgency = Math.max(1, Math.min(10, value));
      } else if ((field === 'importance' || field === 'projectImpact') && typeof value === 'number') {
        task.importance = Math.max(1, Math.min(10, value));
      } else if (field === 'difficulty' && typeof value === 'number') {
        task.difficulty = Math.max(1, Math.min(10, value));
      } else if (field === 'dueDate' && typeof value === 'string') {
        task.dueDate = value;
      } else if (field === 'startDate' && typeof value === 'string') {
        task.startDate = value;
      } else if (field === 'endDate' && typeof value === 'string') {
        task.endDate = value;
      } else if (field === 'status' && typeof value === 'string') {
        task.status = value;
      }
    }

    // Clear ambiguous fields that were resolved
    task._ambiguousFields = {};
  }
}

/**
 * Apply default values when LLM is unavailable or fails.
 * Appends the raw ambiguous text to the task description so nothing is lost.
 */
function applyDefaults(batch, taskIndexMap) {
  for (const { taskKey, ambiguousFields } of batch) {
    const task = taskIndexMap.get(taskKey);
    if (!task) continue;

    // Append raw text to description
    const notes = Object.entries(ambiguousFields)
      .map(([field, value]) => `[${field}: ${value}]`)
      .join(' ');
    if (notes) {
      task.description = task.description
        ? `${task.description}\n${notes}`
        : notes;
    }

    // Apply safe defaults for unresolved fields
    if (ambiguousFields.urgency && task.urgency == null) task.urgency = 1;
    if ((ambiguousFields.importance || ambiguousFields.projectImpact) && task.importance == null) task.importance = 1;
    if (ambiguousFields.difficulty && task.difficulty == null) task.difficulty = 1;

    task._ambiguousFields = {};
  }
}
