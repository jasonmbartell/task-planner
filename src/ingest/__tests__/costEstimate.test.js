import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateExtractionCost,
  pricingFor,
  formatCostLine,
  __TEST_ONLY__,
} from '../costEstimate.js';

describe('estimateTokens', () => {
  it('returns just the system overhead for empty input', () => {
    const r = estimateTokens('');
    expect(r.inputTokens).toBe(__TEST_ONLY__.SYSTEM_PROMPT_TOKENS);
    // Output is floored at OUTPUT_FLOOR_TOKENS
    expect(r.outputTokens).toBe(__TEST_ONLY__.OUTPUT_FLOOR_TOKENS);
  });

  it('handles non-string input gracefully', () => {
    expect(estimateTokens(null).inputTokens).toBe(__TEST_ONLY__.SYSTEM_PROMPT_TOKENS);
    expect(estimateTokens(undefined).inputTokens).toBe(__TEST_ONLY__.SYSTEM_PROMPT_TOKENS);
  });

  it('scales input tokens with content length (~4 chars/token)', () => {
    // 4000 chars → ~1000 content tokens + system overhead
    const r = estimateTokens('x'.repeat(4000));
    expect(r.inputTokens).toBe(1000 + __TEST_ONLY__.SYSTEM_PROMPT_TOKENS);
  });

  it('caps output at the ceiling for very large input', () => {
    // 200KB → 50k tokens content; output ratio 0.15 → 7.5k → capped at 4000
    const r = estimateTokens('x'.repeat(200_000));
    expect(r.outputTokens).toBe(__TEST_ONLY__.OUTPUT_CEILING_TOKENS);
  });

  it('floors output at the minimum for tiny input', () => {
    // 100 chars → 25 content tokens, ratio gives ~4 → floored at 200
    const r = estimateTokens('hello there friend');
    expect(r.outputTokens).toBe(__TEST_ONLY__.OUTPUT_FLOOR_TOKENS);
  });
});

describe('pricingFor', () => {
  it('returns exact pricing for known models', () => {
    const p = pricingFor('claude-opus-4-7');
    expect(p.exact).toBe(true);
    expect(p.inputPerMTok).toBe(15.0);
    expect(p.outputPerMTok).toBe(75.0);
  });

  it('matches case-insensitively', () => {
    const p = pricingFor('Claude-Opus-4-7');
    expect(p.exact).toBe(true);
    expect(p.model).toBe('claude-opus-4-7');
  });

  it('falls back to expensive defaults for unknown models', () => {
    const p = pricingFor('totally-made-up-model');
    expect(p.exact).toBe(false);
    expect(p.inputPerMTok).toBe(__TEST_ONLY__.FALLBACK_PRICING.inputPerMTok);
  });

  it('charges nothing for the local row (Ollama / LM Studio)', () => {
    const p = pricingFor('local');
    expect(p.inputPerMTok).toBe(0);
    expect(p.outputPerMTok).toBe(0);
  });

  it('returns fallback for null / non-string input', () => {
    expect(pricingFor(null).exact).toBe(false);
    expect(pricingFor(undefined).exact).toBe(false);
    expect(pricingFor(42).exact).toBe(false);
  });
});

describe('estimateExtractionCost', () => {
  it('produces a non-zero cost for paid models', () => {
    const r = estimateExtractionCost('hello world '.repeat(500), 'claude-opus-4-7');
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.outputTokens).toBeGreaterThan(0);
    expect(r.exactPricing).toBe(true);
    expect(r.model).toBe('claude-opus-4-7');
  });

  it('produces a zero cost for the local row', () => {
    const r = estimateExtractionCost('lots of text '.repeat(1000), 'local');
    expect(r.costUsd).toBe(0);
  });

  it('opus charges more than haiku for the same input', () => {
    const text = 'sample paragraph '.repeat(2000);
    const opus = estimateExtractionCost(text, 'claude-opus-4-7');
    const haiku = estimateExtractionCost(text, 'claude-haiku-4-5-20251001');
    expect(opus.costUsd).toBeGreaterThan(haiku.costUsd);
  });

  it('flags estimates as inexact when the model is unknown', () => {
    const r = estimateExtractionCost('hello', 'mystery-model-9000');
    expect(r.exactPricing).toBe(false);
  });
});

describe('formatCostLine', () => {
  it('renders a token + dollar line for a known model', () => {
    const line = formatCostLine({
      inputTokens: 4000,
      outputTokens: 200,
      costUsd: 0.05,
      model: 'claude-opus-4-7',
      exactPricing: true,
    });
    expect(line).toContain('4,200 tok');
    expect(line).toContain('$0.05');
    expect(line).toContain('claude-opus-4-7');
    expect(line).not.toContain('est');
    expect(line).not.toContain('~$');
  });

  it('marks the cost as approximate when pricing is inexact', () => {
    const line = formatCostLine({
      inputTokens: 4000, outputTokens: 200,
      costUsd: 0.05,
      model: 'mystery-model',
      exactPricing: false,
    });
    expect(line).toMatch(/~\$0\.05/);
    expect(line).toContain('est');
  });

  it('shows "<$0.01" for very small bills', () => {
    const line = formatCostLine({
      inputTokens: 100, outputTokens: 100,
      costUsd: 0.001,
      model: 'gpt-4o-mini',
      exactPricing: true,
    });
    expect(line).toContain('<$0.01');
  });

  it('shows "free" for zero-cost models', () => {
    const line = formatCostLine({
      inputTokens: 1000, outputTokens: 200,
      costUsd: 0,
      model: 'local',
      exactPricing: true,
    });
    expect(line).toContain('free');
    expect(line).not.toContain('$');
  });

  it('returns empty string for null/undefined input', () => {
    expect(formatCostLine(null)).toBe('');
    expect(formatCostLine(undefined)).toBe('');
  });
});
