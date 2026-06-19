/**
 * Custom vitest matcher: `expect(fn).toBeIdempotent(input, opts?)`.
 *
 * A migration is idempotent when running it twice on equivalent input produces
 * equivalent output. This matcher:
 *
 *   1. Clones the input (deep) so we can run the function twice on fresh copies.
 *   2. Runs `fn(clone1)` and `fn(clone2)` — compares the returned value OR the
 *      mutated clone (some migrations mutate in place, some return a new value).
 *   3. Runs `fn(fn(input-clone))` — compares the result of one pass vs two
 *      passes. True idempotence means pass-once === pass-twice.
 *
 * The matcher runs both checks. If either fails, it fails. Dump a minimal diff
 * so the author can see which pass diverged.
 *
 * Import from test files: `import './idempotent-matcher.js'` (side-effect
 * registers with vitest's expect). Consumers may re-import without cost.
 */

import { expect } from 'vitest';

function deepClone(v) {
  // structuredClone exists in all node versions this project supports.
  // Fall back to JSON if someone is on a stripped runtime.
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

function readOutput(returned, mutatedInput) {
  // If the fn returned something non-null/undefined, trust that.
  // Otherwise fall back to the (possibly mutated) input.
  return returned === undefined || returned === null ? mutatedInput : returned;
}

expect.extend({
  toBeIdempotent(received, input, opts = {}) {
    const { label = 'migration' } = opts;

    if (typeof received !== 'function') {
      return {
        pass: false,
        message: () => `${label}: expected a function, got ${typeof received}`,
      };
    }

    let firstPass, secondPass, doubleApplied;
    try {
      const a = deepClone(input);
      firstPass = readOutput(received(a), a);
    } catch (err) {
      return { pass: false, message: () => `${label}: first pass threw: ${err?.message || err}` };
    }
    try {
      const b = deepClone(input);
      secondPass = readOutput(received(b), b);
    } catch (err) {
      return { pass: false, message: () => `${label}: second pass (independent) threw: ${err?.message || err}` };
    }
    try {
      const c = deepClone(firstPass);
      doubleApplied = readOutput(received(c), c);
    } catch (err) {
      return { pass: false, message: () => `${label}: second invocation on already-migrated result threw: ${err?.message || err}` };
    }

    const sameAcrossFreshRuns = this.equals(firstPass, secondPass);
    const sameAfterDoubleApply = this.equals(firstPass, doubleApplied);

    if (sameAcrossFreshRuns && sameAfterDoubleApply) {
      return { pass: true, message: () => `${label}: is idempotent` };
    }

    const lines = [`${label}: NOT idempotent`];
    if (!sameAcrossFreshRuns) lines.push('• running twice on independent clones of the input produced different outputs (nondeterminism?)');
    if (!sameAfterDoubleApply) lines.push('• applying the migration to its own output produced a DIFFERENT result than applying once');
    lines.push('');
    lines.push(`first-pass output:  ${this.utils.stringify(firstPass)}`);
    lines.push(`double-applied out: ${this.utils.stringify(doubleApplied)}`);

    return {
      pass: false,
      message: () => lines.join('\n'),
    };
  },
});
