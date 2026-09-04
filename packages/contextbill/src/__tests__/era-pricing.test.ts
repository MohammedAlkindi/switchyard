import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCodexRollout } from '../codex-parse.js';
import { priceAll, priceModelUsage, rateInForce } from '../cost.js';
import { parseTranscript } from '../parse.js';
import type { ModelUsage, PriceTable, SessionStat } from '../types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shipped = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;

/**
 * A hand-built table, and it has to be hand-built.
 *
 * `prices.json` carries no dated period, because no rate change this repo can
 * evidence has happened — so the only way to test the mechanism is a fixture
 * table with invented rates that never leaves this file. Inventing them in
 * `prices.json` instead would price real usage against a rate nobody ever
 * charged, which is the failure the whole design is trying to avoid.
 */
const table: PriceTable = {
  dated: '2026-09-02',
  currency: 'USD',
  source: 'hand-built test fixture — not a real price list',
  cacheWriteMultiplier: { '5m': 1.25, '1h': 2, default: '5m' },
  cacheReadMultiplier: 0.1,
  models: {
    'demo-flat': { input: 4, output: 20 },
    'demo-dated': {
      input: 2,
      output: 10,
      periods: [
        { from: '2026-01-01', input: 6, output: 30 },
        { from: '2026-06-01', input: 2, output: 10 },
      ],
    },
    'demo-fast': {
      input: 5,
      output: 25,
      fastInput: 10,
      fastOutput: 50,
      periods: [
        { from: '2026-01-01', input: 3, output: 15, fastInput: 6, fastOutput: 30 },
        { from: '2026-06-01', input: 5, output: 25, fastInput: 10, fastOutput: 50 },
      ],
    },
    'demo-unordered': {
      input: 2,
      output: 10,
      periods: [
        { from: '2026-06-01', input: 2, output: 10 },
        { from: '2026-01-01', input: 6, output: 30 },
      ],
    },
    'demo-bad-date': {
      input: 1,
      output: 5,
      periods: [{ from: 'summer 2026', input: 99, output: 990 }],
    },
  },
  unpricedModels: { ids: [] },
};

const MAR = Date.UTC(2026, 2, 15); // inside the first period
const AUG = Date.UTC(2026, 7, 15); // inside the second
const JUN_1 = Date.UTC(2026, 5, 1); // the boundary day itself
const MAY_31 = Date.UTC(2026, 4, 31, 23, 59, 59, 999);
const LAST_YEAR = Date.UTC(2025, 10, 1); // before every period

function entry(
  model: string,
  usage: Partial<ModelUsage['usage']>,
  at: number | null = null,
  speed: 'standard' | 'fast' = 'standard',
  turns = 1,
): ModelUsage {
  return {
    model,
    speed,
    turns,
    at,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ...usage },
  };
}

describe('rateInForce', () => {
  it('treats a model with no periods as one rate for all time', () => {
    // The backwards-compatibility case, and the only case `prices.json` uses
    // today. A dated turn and an undated one must price identically here, or
    // adding the mechanism moved numbers on its own.
    for (const at of [null, LAST_YEAR, MAR, AUG]) {
      const rate = rateInForce(table.models['demo-flat']!, at);
      expect(rate.input).toBe(4);
      expect(rate.output).toBe(20);
      expect(rate.from).toBeNull();
      expect(rate.assumedEarliest).toBe(false);
    }
  });

  it('returns the rate in force on the day the turn happened', () => {
    const then = rateInForce(table.models['demo-dated']!, MAR);
    expect([then.input, then.output]).toEqual([6, 30]);
    expect(then.from).toBe('2026-01-01');

    const now = rateInForce(table.models['demo-dated']!, AUG);
    expect([now.input, now.output]).toEqual([2, 10]);
    expect(now.from).toBe('2026-06-01');

    // Neither reading is an assumption: both dates sit inside a known period.
    expect(then.assumedEarliest).toBe(false);
    expect(now.assumedEarliest).toBe(false);
  });

  it('starts a period on its own `from` day, inclusive', () => {
    // An off-by-one here reprices a whole day at the wrong rate and nothing
    // fails. `from` is the first day the new rate applies.
    expect(rateInForce(table.models['demo-dated']!, JUN_1).from).toBe('2026-06-01');
    expect(rateInForce(table.models['demo-dated']!, MAY_31).from).toBe('2026-01-01');
  });

  it('falls back to the earliest known rate before every period, and says so', () => {
    const rate = rateInForce(table.models['demo-dated']!, LAST_YEAR);
    expect([rate.input, rate.output]).toEqual([6, 30]);
    expect(rate.from).toBe('2026-01-01');
    // The flag is the point. Pricing at the earliest rate is a guess, and a
    // guess that does not announce itself is indistinguishable from a fact.
    expect(rate.assumedEarliest).toBe(true);
  });

  it('prices an undated turn at the current rate', () => {
    // What this tool did before periods existed. Moving undated usage onto an
    // older rate would change every number on the strength of no evidence.
    const rate = rateInForce(table.models['demo-dated']!, null);
    expect([rate.input, rate.output]).toEqual([2, 10]);
    expect(rate.from).toBe('2026-06-01');
    expect(rate.assumedEarliest).toBe(false);
  });

  it('picks by date, not by position in the file', () => {
    // A hand-edit that appends a period in the wrong place must not be able to
    // change what anything costs.
    expect(rateInForce(table.models['demo-unordered']!, MAR).input).toBe(6);
    expect(rateInForce(table.models['demo-unordered']!, AUG).input).toBe(2);
    expect(rateInForce(table.models['demo-unordered']!, null).input).toBe(2);
  });

  it('ignores a period whose date will not parse rather than guessing', () => {
    // Falls back to the flat rate, which is the only number left that is known
    // to be a real rate. `prices.test.ts` is what stops such a period shipping.
    const rate = rateInForce(table.models['demo-bad-date']!, MAR);
    expect([rate.input, rate.output]).toEqual([1, 5]);
    expect(rate.from).toBeNull();
    expect(rate.assumedEarliest).toBe(false);
  });

  it('takes fast-mode rates from the period too', () => {
    const then = rateInForce(table.models['demo-fast']!, MAR);
    expect([then.fastInput, then.fastOutput]).toEqual([6, 30]);
    const now = rateInForce(table.models['demo-fast']!, AUG);
    expect([now.fastInput, now.fastOutput]).toEqual([10, 50]);
  });
});

describe('priceModelUsage with dated rates', () => {
  it('bills the same tokens differently either side of a rate change', () => {
    const usage = { input: 1_000_000, output: 1_000_000 };
    const then = priceModelUsage(entry('demo-dated', usage, MAR), table, '5m');
    const now = priceModelUsage(entry('demo-dated', usage, AUG), table, '5m');
    expect(then?.total).toBeCloseTo(6 + 30, 9);
    expect(now?.total).toBeCloseTo(2 + 10, 9);
  });

  it('prices cache writes and reads off the period rate as well', () => {
    // Cache is a multiple of the base input rate, so it has to move with the
    // period. Pricing tokens at the old rate and cache at the new one would be
    // internally inconsistent and invisible in a total.
    const priced = priceModelUsage(
      entry('demo-dated', { cacheWrite: 1_000_000, cacheRead: 1_000_000 }, MAR),
      table,
      '5m',
    );
    expect(priced?.cacheWrite).toBeCloseTo(6 * 1.25, 9);
    expect(priced?.cacheRead).toBeCloseTo(6 * 0.1, 9);
  });

  it('bills fast mode at the fast rate of the period the turn fell in', () => {
    const fast = priceModelUsage(
      entry('demo-fast', { output: 1_000_000 }, MAR, 'fast'),
      table,
      '5m',
    );
    expect(fast?.output).toBeCloseTo(30, 9);
  });

  it('lets a caller pass a timestamp the entry does not carry', () => {
    const undated = entry('demo-dated', { output: 1_000_000 });
    expect(priceModelUsage(undated, table, '5m')?.output).toBeCloseTo(10, 9);
    expect(priceModelUsage(undated, table, '5m', MAR)?.output).toBeCloseTo(30, 9);
  });
});

describe('priceAll reports the era assumption', () => {
  it('names usage priced before the earliest known rate', () => {
    const result = priceAll(
      [
        entry('demo-dated', { output: 1_000_000 }, LAST_YEAR, 'standard', 3),
        entry('demo-dated', { output: 1_000_000 }, LAST_YEAR - 86_400_000, 'standard', 2),
        entry('demo-dated', { output: 1_000_000 }, AUG, 'standard', 9),
      ],
      table,
      '5m',
    );

    // Both pre-period buckets are still priced — dropping them, or pricing them
    // at zero, would understate a real bill.
    expect(result.cost.output).toBeCloseTo(30 + 30 + 10, 9);
    expect(result.eraAssumptions).toEqual([
      {
        model: 'demo-dated',
        entries: 2,
        turns: 5,
        earliestAt: LAST_YEAR - 86_400_000,
        appliedFrom: '2026-01-01',
      },
    ]);
  });

  it('raises nothing when every turn sits inside a known period', () => {
    const result = priceAll(
      [entry('demo-dated', { output: 1 }, MAR), entry('demo-dated', { output: 1 }, AUG)],
      table,
      '5m',
    );
    expect(result.eraAssumptions).toEqual([]);
  });

  it('raises nothing for undated usage, which is priced at the current rate', () => {
    // Undated usage is not an era assumption — it is the documented default.
    // Flagging it would put a line in every report and mean nothing.
    const result = priceAll([entry('demo-dated', { output: 1 })], table, '5m');
    expect(result.eraAssumptions).toEqual([]);
  });
});

describe('the shipped table is unaffected by the mechanism', () => {
  it('carries no dated period at all', () => {
    // Deliberate, and documented in prices.json under `$comment-rate-periods`:
    // the Sonnet 5 move from $3/$15 to $2/$10 was this table being wrong, not a
    // rate that changed, so there is no earlier rate to date. A period added
    // here without a published source behind it is worse than no history.
    const withPeriods = Object.entries(shipped.models).filter(
      ([, price]) => (price.periods?.length ?? 0) > 0,
    );
    expect(withPeriods.map(([id]) => id)).toEqual([]);
  });

  it('prices every shipped model identically dated and undated', () => {
    // The backwards-compatibility guarantee, stated over the real table rather
    // than a fixture: while no model carries a period, a timestamp cannot change
    // a single dollar figure.
    for (const [id, price] of Object.entries(shipped.models)) {
      for (const at of [null, LAST_YEAR, MAR, AUG]) {
        const rate = rateInForce(price, at);
        expect(rate.input, `${id} @ ${String(at)}`).toBe(price.input);
        expect(rate.output, `${id} @ ${String(at)}`).toBe(price.output);
        expect(rate.assumedEarliest, `${id} @ ${String(at)}`).toBe(false);
      }
    }
  });
});

/**
 * The half of dated pricing that lives in the readers.
 *
 * `rateInForce` above is exercised against hand-made `ModelUsage` values, so it
 * passed for months while NOTHING in the pipeline ever set `at`. Every real row
 * arrived undated, `rateInForce` took the `at === null` branch, and the whole
 * mechanism resolved to "price everything at today's rate" — the exact failure
 * dated periods exist to prevent, wearing the costume of a feature.
 *
 * These tests run the real producers. A row that reaches `priceAll` without a
 * timestamp on it is the bug, so they assert the OLD rate comes back, which is
 * only possible if the reader dated the row.
 */

/** One Claude transcript line, hand-built. Never a real transcript — see CLAUDE.md. */
function claudeLine(id: string, timestamp: string | null, outputTokens: number): string {
  const message = { id, model: 'demo-dated', usage: { output_tokens: outputTokens } };
  return JSON.stringify(timestamp === null ? { message } : { timestamp, message });
}

function claudeStat(lines: readonly string[]): SessionStat {
  return parseTranscript(`${lines.join('\n')}\n`, {
    id: 'dated',
    project: 'demo',
    isSubagent: true, // keeps the startup prefix out of the arithmetic below
    bytes: 0,
  });
}

/** A Codex `token_count` event carrying a cumulative counter. */
function codexEvent(timestamp: string, inputTotal: number, outputTotal: number): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: inputTotal,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: outputTotal,
          total_tokens: inputTotal + outputTotal,
        },
      },
    },
  });
}

function codexStat(lines: readonly string[]): SessionStat {
  return parseCodexRollout(`${lines.join('\n')}\n`, { id: 'dated', bytes: 0 });
}

const CODEX_MODEL = JSON.stringify({
  timestamp: '2026-03-15T09:59:00Z',
  type: 'turn_context',
  payload: { model: 'demo-dated', cwd: '/home/demo/proj' },
});

describe('the readers date the rows they produce', () => {
  it('prices a Claude turn at the rate in force the day it ran', () => {
    // March 2026 sits in the first period ($6/$30), not the current one
    // ($2/$10). Undated, this same million output tokens comes back as $10.
    const stat = claudeStat([claudeLine('m1', '2026-03-15T10:00:00Z', 1_000_000)]);
    expect(stat.byModel).toHaveLength(1);
    expect(stat.byModel[0]?.at).toBe(Date.parse('2026-03-15T10:00:00Z'));
    expect(priceAll(stat.byModel, table, '5m').cost.output).toBeCloseTo(30, 9);
  });

  it('prices a Codex turn at the rate in force the day it ran', () => {
    const stat = codexStat([CODEX_MODEL, codexEvent('2026-03-15T10:00:00Z', 0, 1_000_000)]);
    expect(stat.byModel).toHaveLength(1);
    expect(stat.byModel[0]?.at).toBe(Date.parse('2026-03-15T10:00:00Z'));
    expect(priceAll(stat.byModel, table, '5m').cost.output).toBeCloseTo(30, 9);
  });

  it('splits a Claude session that crosses a rate change, and bills each side', () => {
    // A `ModelUsage` row is an aggregate, so one timestamp cannot be right for a
    // row whose turns straddle a price move. The readers cut every row on the
    // UTC day, which is finer than any period boundary a `YYYY-MM-DD` `from` can
    // express, so no row can span one. Without the cut this session prices at
    // $20 — both halves at today's rate — and nothing fails.
    const stat = claudeStat([
      claudeLine('m1', '2026-05-31T23:00:00Z', 1_000_000),
      claudeLine('m2', '2026-06-01T01:00:00Z', 1_000_000),
    ]);

    expect(stat.turns).toBe(2);
    expect(stat.byModel).toHaveLength(2);
    expect(priceAll(stat.byModel, table, '5m').cost.output).toBeCloseTo(30 + 10, 9);
  });

  it('splits a Codex session that crosses a rate change, and bills each side', () => {
    const stat = codexStat([
      JSON.stringify({
        timestamp: '2026-05-31T22:00:00Z',
        type: 'turn_context',
        payload: { model: 'demo-dated', cwd: '/home/demo/proj' },
      }),
      codexEvent('2026-05-31T23:00:00Z', 0, 1_000_000),
      codexEvent('2026-06-01T01:00:00Z', 0, 2_000_000),
    ]);

    expect(stat.turns).toBe(2);
    expect(stat.byModel).toHaveLength(2);
    expect(priceAll(stat.byModel, table, '5m').cost.output).toBeCloseTo(30 + 10, 9);
  });

  it('splits by day without moving the tokens, the turns or the totals', () => {
    // The cut is a re-bucketing and nothing else. If it ever changes a token
    // count or a turn count it has stopped being free.
    const stat = claudeStat([
      claudeLine('m1', '2026-05-31T23:00:00Z', 7),
      claudeLine('m2', '2026-06-01T01:00:00Z', 11),
      claudeLine('m3', '2026-06-01T02:00:00Z', 13),
    ]);

    expect(stat.turns).toBe(3);
    expect(stat.usage.output).toBe(31);
    expect(stat.byModel.reduce((n, m) => n + m.usage.output, 0)).toBe(31);
    expect(stat.byModel.reduce((n, m) => n + m.turns, 0)).toBe(3);
  });

  it('leaves a line with no usable timestamp undated rather than guessing one', () => {
    // An undated row is priced at the current rate, which is the documented
    // default. Borrowing a neighbouring line's timestamp would move real money
    // onto a rate on the strength of file order alone.
    const stat = claudeStat([claudeLine('m1', null, 1_000_000)]);
    expect(stat.byModel[0]?.at).toBeNull();
    expect(priceAll(stat.byModel, table, '5m').cost.output).toBeCloseTo(10, 9);
  });

  it('keeps a dated and an undated turn of the same model in separate rows', () => {
    const stat = claudeStat([
      claudeLine('m1', '2026-03-15T10:00:00Z', 1_000_000),
      claudeLine('m2', null, 1_000_000),
    ]);
    expect(stat.byModel).toHaveLength(2);
    expect(priceAll(stat.byModel, table, '5m').cost.output).toBeCloseTo(30 + 10, 9);
  });
});
