import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { PriceTable } from '../types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;

/**
 * Guards on the price table itself.
 *
 * Every dollar figure the product reports derives from `prices.json`, and a wrong
 * rate throws nothing: the report renders, the tests pass, and every number is
 * quietly wrong. These are the cheap structural checks. The expensive one — that
 * the rates match what Anthropic actually publishes — cannot be automated without
 * a network call, which is why the staleness check below exists instead.
 */
describe('prices.json', () => {
  it('is not more than 60 days old', () => {
    const dated = new Date(`${table.dated}T00:00:00Z`);
    expect(Number.isNaN(dated.getTime())).toBe(false);

    const ageDays = (Date.now() - dated.getTime()) / 86_400_000;

    // This test is meant to go red on its own, and the failure is the feature.
    // Nothing else in the suite notices that a rate moved: a stale table produces
    // a confident, wrong number rather than an error. When it fails, re-read
    // https://platform.claude.com/docs/en/about-claude/pricing, correct any rate
    // that moved, and update `dated` in the same commit. Do not just bump the date
    // — that converts the one check that catches drift into a no-op.
    expect(ageDays).toBeLessThan(60);
  });

  it('is not dated in the future', () => {
    const dated = new Date(`${table.dated}T00:00:00Z`);
    expect(dated.getTime()).toBeLessThan(Date.now() + 86_400_000);
  });

  it('gives every model both an input and an output rate', () => {
    for (const [id, price] of Object.entries(table.models)) {
      expect(typeof price.input, `${id}.input`).toBe('number');
      expect(typeof price.output, `${id}.output`).toBe('number');
      expect(price.input, `${id}.input`).toBeGreaterThan(0);
      expect(price.output, `${id}.output`).toBeGreaterThan(0);
    }
  });

  it('prices output above input for every model', () => {
    // True of every Claude model Anthropic has published. A table where it does not
    // hold is far more likely to have transposed a row than to have found an
    // exception, and transposing input and output is silent in every other check.
    for (const [id, price] of Object.entries(table.models)) {
      expect(price.output > price.input, `${id}: output ${price.output} <= input ${price.input}`).toBe(
        true,
      );
    }
  });

  it('keeps the cache multipliers in their documented order', () => {
    // 5m writes at 1.25x base input, 1h at 2x, reads at 0.1x. Swapping the two write
    // multipliers would make the default the expensive assumption, inverting the
    // "understate rather than overstate" property the whole TTL design rests on.
    expect(table.cacheWriteMultiplier['5m']).toBe(1.25);
    expect(table.cacheWriteMultiplier['1h']).toBe(2);
    expect(table.cacheReadMultiplier).toBe(0.1);
    expect(table.cacheWriteMultiplier['5m']).toBeLessThan(table.cacheWriteMultiplier['1h']);
  });

  it('carries no comment key inside the model map', () => {
    // `$comment` belongs beside `models`, never inside it: a comment key there is
    // indistinguishable from a model to anything that iterates the map.
    for (const id of Object.keys(table.models)) {
      expect(id.startsWith('$'), `models.${id} is a comment, not a model`).toBe(false);
    }
  });
});
