import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  cacheWriteMultiplier,
  normalizeModelId,
  priceAll,
  priceModelUsage,
  rateInForce,
  usd,
} from '../cost.js';
import type { ModelUsage, PriceTable } from '../types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;

function entry(model: string, usage: Partial<ModelUsage['usage']>, speed: 'standard' | 'fast' = 'standard'): ModelUsage {
  return {
    model,
    speed,
    turns: 1,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ...usage },
  };
}

describe('normalizeModelId', () => {
  it('strips dated snapshot suffixes that appear in real transcripts', () => {
    // Without this, a real model prices at zero and the bill silently understates.
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-opus-5')).toBe('claude-opus-5');
  });

  it('strips Vertex @-version separators', () => {
    expect(normalizeModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5');
  });

  it('leaves an id with a non-date numeric tail alone', () => {
    expect(normalizeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('priceModelUsage', () => {
  it('prices opus-5 input, cache and output at the published rates', () => {
    const priced = priceModelUsage(
      entry('claude-opus-5', { input: 15, cacheWrite: 1000, cacheRead: 1000, output: 70 }),
      table,
      '5m',
    );
    expect(priced).not.toBeNull();
    // $5/M input, $25/M output, cache write 1.25x input, cache read 0.1x input.
    expect(priced?.input).toBeCloseTo((15 / 1e6) * 5, 12);
    expect(priced?.cacheWrite).toBeCloseTo((1000 / 1e6) * 5 * 1.25, 12);
    expect(priced?.cacheRead).toBeCloseTo((1000 / 1e6) * 5 * 0.1, 12);
    expect(priced?.output).toBeCloseTo((70 / 1e6) * 25, 12);
    expect(priced?.total).toBeCloseTo(0.008575, 12);
  });

  it('charges the 1h TTL rate at 2x when asked', () => {
    const at5m = priceModelUsage(entry('claude-opus-5', { cacheWrite: 1_000_000 }), table, '5m');
    const at1h = priceModelUsage(entry('claude-opus-5', { cacheWrite: 1_000_000 }), table, '1h');
    expect(at5m?.cacheWrite).toBeCloseTo(6.25, 10);
    expect(at1h?.cacheWrite).toBeCloseTo(10.0, 10);
    // The 5m default must never exceed the 1h figure, or "conservative" is a lie.
    expect(at5m?.total).toBeLessThan(at1h?.total ?? 0);
  });

  it('bills fast mode at the premium rate', () => {
    const standard = priceModelUsage(entry('claude-opus-5', { output: 1e6 }), table, '5m');
    const fast = priceModelUsage(entry('claude-opus-5', { output: 1e6 }, 'fast'), table, '5m');
    expect(standard?.output).toBeCloseTo(25, 10);
    expect(fast?.output).toBeCloseTo(50, 10);
  });

  it('falls back to standard rates for a model with no fast tier', () => {
    // Read the expected rate off the table rather than hardcoding it. What this
    // test is for is the fallback branch, not Sonnet 5's price — pinning the
    // literal made it fail when that rate was corrected, which is noise. The one
    // assertion that deliberately pins rates is the anchor in pipeline.test.ts.
    const standardOutput = table.models['claude-sonnet-5']?.output ?? 0;
    expect(standardOutput).toBeGreaterThan(0);

    const fast = priceModelUsage(entry('claude-sonnet-5', { output: 1e6 }, 'fast'), table, '5m');
    expect(fast?.output).toBeCloseTo(standardOutput, 10);
  });

  it('returns null rather than zero for an unknown model', () => {
    expect(priceModelUsage(entry('some-other-vendor-model', { output: 1e9 }), table, '5m')).toBeNull();
  });
});

describe('priceAll', () => {
  it('collects unpriced models instead of folding them in as free', () => {
    const result = priceAll(
      [entry('claude-opus-5', { output: 1e6 }), entry('<synthetic>', { output: 1e9 })],
      table,
      '5m',
    );
    expect(result.cost.total).toBeCloseTo(25, 10);
    expect(result.unpriced).toEqual(['<synthetic>']);
  });
});

describe('cacheWriteMultiplier', () => {
  it('reads the table and defaults safely', () => {
    expect(cacheWriteMultiplier(table, '5m')).toBe(1.25);
    expect(cacheWriteMultiplier(table, '1h')).toBe(2.0);
  });
});

describe('usd', () => {
  it('keeps enough digits on sub-cent amounts to be checkable by hand', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.0001234)).toBe('$0.0001');
  });

  it('uses one precision above a cent so a column never mixes formats', () => {
    // A table column holding both $491.03 and $7,419 reads as two different
    // units. Two decimals throughout, grouped, is the same shape at every
    // magnitude the real data spans.
    expect(usd(12.5)).toBe('$12.50');
    expect(usd(491.031)).toBe('$491.03');
    expect(usd(45210.4)).toBe('$45,210.40');
    expect(usd(23367.22911)).toBe('$23,367.23');
  });
});

/**
 * OpenAI rates, priced through exactly the same path as the Anthropic ones.
 *
 * Rates read 2026-09-07 from https://developers.openai.com/api/docs/pricing and
 * each model's own page. Cache behaviour from
 * https://developers.openai.com/api/docs/guides/prompt-caching: on GPT-5.6 and
 * later a cache write costs 1.25x the uncached input rate and a cache read 0.1x
 * — numerically the same two multipliers the table already carries for
 * Anthropic's 5-minute TTL, which is why these entries are safe under a single
 * global multiplier and gpt-5.5 (no cache-write premium at all) is not.
 */
describe('OpenAI rates', () => {
  it('prices gpt-5.6-sol input, cache and output at the published rates', () => {
    const priced = priceModelUsage(
      entry('gpt-5.6-sol', { input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }),
      table,
      '5m',
    );
    expect(priced).not.toBeNull();
    // $4/M input, $20/M output, cache write 1.25 x 4 = $5/M, read 0.1 x 4 = $0.40/M.
    expect(priced?.input).toBeCloseTo(4, 10);
    expect(priced?.cacheWrite).toBeCloseTo(5, 10);
    expect(priced?.cacheRead).toBeCloseTo(0.4, 10);
    expect(priced?.output).toBeCloseTo(20, 10);
    expect(priced?.total).toBeCloseTo(29.4, 10);
  });

  it('prices gpt-5.6-terra at its own, lower rates', () => {
    const priced = priceModelUsage(
      entry('gpt-5.6-terra', { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }),
      table,
      '5m',
    );
    // $2/M input, $12/M output, read 0.1 x 2 = $0.20/M.
    expect(priced?.input).toBeCloseTo(2, 10);
    expect(priced?.cacheRead).toBeCloseTo(0.2, 10);
    expect(priced?.output).toBeCloseTo(12, 10);
    expect(priced?.total).toBeCloseTo(14.2, 10);
  });

  it('discounts a cached input token to a tenth, never charges it as fresh', () => {
    // Cached input is the largest token class on a real Codex corpus — 725 of
    // 732 token_count events on this machine carried a non-zero
    // cached_input_tokens. Pricing it as fresh input would be the single
    // largest error available in this file.
    const cached = priceModelUsage(entry('gpt-5.6-sol', { cacheRead: 1_000_000 }), table, '5m');
    const fresh = priceModelUsage(entry('gpt-5.6-sol', { input: 1_000_000 }), table, '5m');
    expect((cached?.total ?? 0) * 10).toBeCloseTo(fresh?.total ?? 0, 10);
  });

  it('charges reasoning tokens at the output rate, because they ARE output tokens', () => {
    // https://developers.openai.com/api/docs/guides/reasoning: reasoning tokens
    // "are billed as output tokens". Codex reports reasoning_output_tokens as a
    // SUBSET of output_tokens, so codex-parse.ts deliberately never adds it —
    // the tokens are already inside `output` and already priced here. This is
    // the pricing-side half of that decision: 900 output tokens containing 270
    // reasoning tokens cost 900 x $20/M, not 1,170 x $20/M.
    const priced = priceModelUsage(entry('gpt-5.6-sol', { output: 900 }), table, '5m');
    expect(priced?.output).toBeCloseTo((900 / 1e6) * 20, 12);
    expect(priced?.output).not.toBeCloseTo(((900 + 270) / 1e6) * 20, 12);
  });

  it('counts gpt-5.5 separately rather than folding it in as free', () => {
    // gpt-5.5 appears in real rollouts and is DELIBERATELY absent — see
    // $comment-missing-gpt-5-5 in prices.json. The requirement is that an
    // unpriced model is loud: null from the pricer, and named in `unpriced`.
    expect(priceModelUsage(entry('gpt-5.5', { input: 1_000_000 }), table, '5m')).toBeNull();
    const totals = priceAll(
      [entry('gpt-5.5', { input: 1_000_000, output: 1_000_000 }), entry('gpt-5.6-sol', { input: 1_000_000 })],
      table,
      '5m',
    );
    expect(totals.unpriced).toEqual(['gpt-5.5']);
    // Only sol's dollars are in the total. gpt-5.5's two million tokens
    // contribute nothing, which is why the caller has to print `unpriced`.
    expect(totals.cost.total).toBeCloseTo(4, 10);
  });

  it('routes OpenAI entries through rateInForce with no invented history', () => {
    // The dated-period mechanism applies to every vendor equally. Neither
    // OpenAI entry carries a period, because no PAST rate change is evidenced —
    // gpt-5.6-sol's price is promotional "at least through" a future date,
    // which says nothing about what was charged before. So every timestamp
    // resolves to the flat rate, and nothing is ever flagged as assumed.
    for (const [id, input, output] of [
      ['gpt-5.6-sol', 4, 20],
      ['gpt-5.6-terra', 2, 12],
    ] as const) {
      const price = table.models[id];
      expect(price, `${id} is not in the table`).toBeDefined();
      if (price === undefined) continue;
      for (const at of [null, Date.UTC(2024, 0, 1), Date.UTC(2026, 8, 7)]) {
        const rate = rateInForce(price, at);
        expect(rate.input, `${id} @ ${String(at)}`).toBe(input);
        expect(rate.output, `${id} @ ${String(at)}`).toBe(output);
        expect(rate.from).toBeNull();
        expect(rate.assumedEarliest).toBe(false);
      }
    }
  });

  it('gives OpenAI models no fast tier, because Codex records no speed', () => {
    // A fast rate the transcript never claimed would price standard turns at a
    // premium. Codex has no equivalent of usage.speed, so asking for `fast`
    // must fall back to the standard rate rather than to a second set of
    // numbers nobody published.
    const standard = priceModelUsage(entry('gpt-5.6-sol', { input: 1_000_000 }), table, '5m');
    const fast = priceModelUsage(entry('gpt-5.6-sol', { input: 1_000_000 }, 'fast'), table, '5m');
    expect(table.models['gpt-5.6-sol']?.fastInput).toBeUndefined();
    expect(fast?.total).toBeCloseTo(standard?.total ?? 0, 12);
  });
});
