import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cacheWriteMultiplier, normalizeModelId, priceAll, priceModelUsage, usd } from '../cost.js';
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
