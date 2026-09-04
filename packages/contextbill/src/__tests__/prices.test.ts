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

  it('dates every rate period validly, uniquely and in ascending order', () => {
    // Periods are chosen by date rather than by file position, so an out-of-order
    // or unparseable one does not change what anything costs — it just makes the
    // file unreadable to a human, which is how a wrong rate survives review.
    // Vacuous while no model carries a period; it has teeth the day one does.
    for (const [id, price] of Object.entries(table.models)) {
      const periods = price.periods ?? [];
      const starts = periods.map((p) => Date.parse(`${p.from}T00:00:00Z`));
      starts.forEach((start, i) => {
        expect(Number.isNaN(start), `${id}.periods[${i}].from is not a YYYY-MM-DD date`).toBe(false);
      });
      expect(new Set(starts).size, `${id}: two periods start on the same day`).toBe(starts.length);
      expect([...starts].sort((a, b) => a - b), `${id}: periods are not earliest-first`).toEqual(
        starts,
      );
    }
  });

  it('prices output above input in every dated period', () => {
    // Same transposition check as the flat rates above. A period is a rate like
    // any other and gets no exemption from the structural guards.
    for (const [id, price] of Object.entries(table.models)) {
      for (const period of price.periods ?? []) {
        expect(typeof period.input, `${id}@${period.from}.input`).toBe('number');
        expect(typeof period.output, `${id}@${period.from}.output`).toBe('number');
        expect(period.input, `${id}@${period.from}.input`).toBeGreaterThan(0);
        expect(
          period.output > period.input,
          `${id}@${period.from}: output ${period.output} <= input ${period.input}`,
        ).toBe(true);
      }
    }
  });

  it('ends every period list on the current flat rate', () => {
    // The flat `input`/`output` are the rate in force NOW. Anything that has not
    // been taught about periods reads those, so if the last period disagrees with
    // them the two consumers price today's usage differently and neither errors.
    for (const [id, price] of Object.entries(table.models)) {
      const periods = price.periods ?? [];
      if (periods.length === 0) continue;
      const last = periods[periods.length - 1]!;
      expect(last.input, `${id}: last period input != flat input`).toBe(price.input);
      expect(last.output, `${id}: last period output != flat output`).toBe(price.output);
      expect(last.fastInput, `${id}: last period fastInput != flat fastInput`).toBe(price.fastInput);
      expect(last.fastOutput, `${id}: last period fastOutput != flat fastOutput`).toBe(
        price.fastOutput,
      );
    }
  });

  it('carries no comment key inside the plan map', () => {
    // Same failure as the model map: a $comment key here would be iterated as a
    // plan, so --plan would list it as supported and then price against nothing.
    for (const id of Object.keys(table.plans?.entries ?? {})) {
      expect(id.startsWith('$'), `plans.entries.${id} is a comment, not a plan`).toBe(false);
    }
  });

  it('dates and sources the plan prices separately from the API rates', () => {
    // Plan prices and per-token rates move for different reasons and on
    // different schedules. One `dated` covering both would let a fresh API-rate
    // reading vouch for a plan price nobody re-read.
    const plans = table.plans;
    expect(plans, 'prices.json needs a plans block for --plan').toBeDefined();
    if (plans === undefined) return;
    expect(Number.isNaN(Date.parse(`${plans.dated}T00:00:00Z`))).toBe(false);
    expect(Date.parse(`${plans.dated}T00:00:00Z`)).toBeLessThan(Date.now() + 86_400_000);
    expect(plans.source.length, 'a plan price with no source cannot be audited').toBeGreaterThan(20);
  });

  it('does not let the plan prices go more than 60 days unread', () => {
    // Same design as the model-rate staleness check above, and for the same
    // reason: a plan price that moved changes the break-even multiple --- the
    // one figure in this product somebody screenshots --- and nothing else in
    // the suite notices, because a wrong denominator still divides cleanly.
    // When this goes red, re-read the pricing page, correct any plan whose
    // price moved, and update plans.dated in the same commit. Bumping the date
    // alone converts the only check that catches drift into a no-op.
    const plans = table.plans;
    expect(plans).toBeDefined();
    if (plans === undefined) return;
    const ageDays = (Date.now() - Date.parse(`${plans.dated}T00:00:00Z`)) / 86_400_000;
    expect(ageDays).toBeLessThan(60);
  });

  it('gives every flat plan a monthly price and every metered plan none', () => {
    // A flat plan with no price would divide by zero or by undefined; a metered
    // plan with one would invent a subscription fee that does not exist. Both
    // render as a plausible number rather than as an error.
    for (const [id, plan] of Object.entries(table.plans?.entries ?? {})) {
      expect(plan.label.length, `${id}.label`).toBeGreaterThan(0);
      if (plan.billing === 'flat') {
        expect(typeof plan.usdPerMonth, `${id}.usdPerMonth`).toBe('number');
        expect(plan.usdPerMonth ?? 0, `${id}.usdPerMonth`).toBeGreaterThan(0);
      } else {
        expect(plan.billing, `${id}.billing`).toBe('metered');
        expect(plan.usdPerMonth, `${id} is metered and must carry no monthly fee`).toBeUndefined();
      }
    }
  });

  it('never prices annual billing above monthly billing', () => {
    // The break-even multiple divides by usdPerMonth deliberately, because it
    // is the larger of the two. If a row ever inverted that, the feature would
    // silently start over-claiming for everyone on that plan.
    for (const [id, plan] of Object.entries(table.plans?.entries ?? {})) {
      if (plan.usdPerMonthAnnual === undefined) continue;
      expect(
        plan.usdPerMonthAnnual < (plan.usdPerMonth ?? 0),
        `${id}: annual ${plan.usdPerMonthAnnual} >= monthly ${plan.usdPerMonth}`,
      ).toBe(true);
    }
  });

  it('notes where every plan price came from', () => {
    // A plan price is a vendor fact copied by hand. Without a note saying which
    // page it was copied from, a wrong figure is indistinguishable from a right
    // one on review, and nothing else in this suite can tell them apart either.
    for (const [id, plan] of Object.entries(table.plans?.entries ?? {})) {
      expect((plan.note ?? '').length, `plans.entries.${id} carries no note`).toBeGreaterThan(20);
    }
  });

  it('carries no comment key inside the model map', () => {
    // `$comment` belongs beside `models`, never inside it: a comment key there is
    // indistinguishable from a model to anything that iterates the map.
    for (const id of Object.keys(table.models)) {
      expect(id.startsWith('$'), `models.${id} is a comment, not a model`).toBe(false);
    }
  });
});
