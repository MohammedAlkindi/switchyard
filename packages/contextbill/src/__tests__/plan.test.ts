import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregate, planUtilization } from '../aggregate.js';
import { parseArgs } from '../cli.js';
import { cacheWriteMultiplier } from '../cost.js';
import { renderReport } from '../report.js';
import { scanAll } from '../scan.js';
import type { PlanTable, PriceTable, SessionStat } from '../types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;

function plans(): PlanTable {
  const p = table.plans;
  if (p === undefined) throw new Error('prices.json carries no plans block');
  return p;
}

/**
 * One synthetic session worth exactly $25.00 at API rates.
 *
 * 1,000,000 output tokens on claude-opus-5 at $25/M, with no input, no cache
 * and no startup prefix, so the whole priced total is one round number and any
 * arithmetic below can be checked by hand rather than against what the code
 * emits.
 */
function session(id: string, startedAt: number | null, endedAt: number | null): SessionStat {
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 1_000_000 };
  return {
    file: `${id}.jsonl`,
    project: 'demo',
    id,
    turns: 1,
    usage,
    byModel: [{ model: 'claude-opus-5', speed: 'standard', usage, turns: 1 }],
    startupPrefix: 0,
    isSubagent: false,
    toolBytes: {},
    connectorBytes: {},
    connectorCalls: {},
    producedFile: true,
    fileWrites: 1,
    startedAt,
    endedAt,
    bytes: 4096,
    usageRewrites: 0,
    unidentifiedUsage: 0,
    messageIds: [],
  };
}

const ms = (iso: string): number => Date.parse(iso);

/**
 * A corpus spanning 2026-06-01 to 2026-08-05:
 *   June  — one session,  $25, covered end to end
 *   July  — two sessions, $50, covered end to end
 *   August — one session, $25, four days of coverage out of thirty-one
 * plus one undated session worth $25 that belongs to no month at all.
 */
function corpus(): SessionStat[] {
  return [
    session('jun', ms('2026-06-01T00:00:00Z'), ms('2026-06-01T01:00:00Z')),
    session('jul-a', ms('2026-07-10T00:00:00Z'), ms('2026-07-10T01:00:00Z')),
    session('jul-b', ms('2026-07-20T00:00:00Z'), ms('2026-07-20T01:00:00Z')),
    session('aug', ms('2026-08-01T00:00:00Z'), ms('2026-08-05T00:00:00Z')),
    session('undated', null, null),
  ];
}

function report(stats: readonly SessionStat[]): ReturnType<typeof aggregate> {
  return aggregate(stats, { table, ttl: '5m', cacheWriteMult: cacheWriteMultiplier(table, '5m') });
}

describe('byMonth', () => {
  const r = report(corpus());

  it('buckets sessions into UTC calendar months, oldest first', () => {
    expect(r.byMonth.map((m) => m.month)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(r.byMonth.map((m) => m.usd)).toEqual([25, 50, 25]);
    expect(r.byMonth.map((m) => m.turns)).toEqual([1, 2, 1]);
  });

  it('marks a month complete only when the corpus brackets the whole of it', () => {
    // The end months of any corpus are fragments: it begins at the oldest
    // transcript that still exists and ends at the newest, and neither is a
    // month boundary. Getting this wrong is what turns a three-day sample into
    // a confident monthly figure.
    expect(r.byMonth.map((m) => m.complete)).toEqual([true, true, false]);
  });

  it('measures coverage in real days, not in thirtieths', () => {
    expect(r.byMonth[0]?.daysInMonth).toBe(30); // June
    expect(r.byMonth[1]?.daysInMonth).toBe(31); // July
    expect(r.byMonth[2]?.daysInMonth).toBe(31); // August
    expect(r.byMonth[2]?.daysCovered).toBeCloseTo(4, 9);
  });

  it('keeps undated usage out of every month and states its value', () => {
    // Dropping it would understate the corpus; guessing a month for it would
    // move real money into a month it did not happen in.
    expect(r.undatedUsd).toBeCloseTo(25, 9);
    const inMonths = r.byMonth.reduce((n, m) => n + m.usd, 0);
    expect(inMonths + r.undatedUsd).toBeCloseTo(r.cost.total, 9);
  });
});

describe('planUtilization', () => {
  const r = report(corpus());

  it('divides only whole months by the fee', () => {
    // By hand: June $25 + July $50 = $75 of API-equivalent value across two
    // whole months. Pro is $20/month billed monthly, so $40 of fees, so 1.875x.
    // August is excluded — four days of usage against a whole month's fee.
    const p = planUtilization(r, plans(), 'pro');
    expect(p.completeMonths).toBe(2);
    expect(p.completeUsd).toBeCloseTo(75, 9);
    expect(p.completePlanUsd).toBeCloseTo(40, 9);
    expect(p.ratio).toBeCloseTo(1.875, 9);
  });

  it('would report a different multiple if the partial month were folded in', () => {
    // ($75 + $25) / (3 x $20) = 1.667x. Not a rounding difference: a fragment
    // charged against a whole month's fee drags the multiple down, so folding
    // it in understates and reads as caution rather than as error.
    const p = planUtilization(r, plans(), 'pro');
    const naive = (p.completeUsd + 25) / (20 * 3);
    expect(naive).toBeLessThan(p.ratio ?? 0);
    expect(p.ratio).not.toBeCloseTo(naive, 3);
  });

  it('refuses a multiple when no month is complete', () => {
    // One week of transcripts is the common case for a first run, and it is
    // exactly the case where a break-even multiple would be fabricated.
    const week = report([session('a', ms('2026-06-04T00:00:00Z'), ms('2026-06-11T00:00:00Z'))]);
    const p = planUtilization(week, plans(), 'max20');
    expect(p.completeMonths).toBe(0);
    expect(p.ratio).toBeNull();
    expect(p.months).toHaveLength(1);
    expect(p.months[0]?.complete).toBe(false);
  });

  it('reports no multiple at all for a metered plan', () => {
    // The API has no flat fee. A 1.0 here would invent a break-even point.
    const p = planUtilization(r, plans(), 'api');
    expect(p.billing).toBe('metered');
    expect(p.usdPerMonth).toBeNull();
    expect(p.ratio).toBeNull();
    expect(p.months.every((m) => m.ratio === null)).toBe(true);
  });

  it('divides by the monthly-billed price, which is the larger denominator', () => {
    // Where a plan offers annual billing the annual per-month price is lower,
    // so dividing by the monthly one yields the smaller multiple. Reversing it
    // would inflate every figure this feature prints for Pro and Team users.
    const p = planUtilization(r, plans(), 'pro');
    expect(p.usdPerMonth).toBe(20);
    expect(p.usdPerMonthAnnual).toBe(17);
    expect(p.usdPerMonthAnnual ?? 0).toBeLessThan(p.usdPerMonth ?? 0);
    expect(p.ratio ?? 0).toBeLessThan(p.completeUsd / ((p.usdPerMonthAnnual ?? 1) * 2));
  });

  it('scales inversely with the plan price', () => {
    const pro = planUtilization(r, plans(), 'pro');
    const max20 = planUtilization(r, plans(), 'max20');
    expect(max20.ratio).toBeCloseTo(75 / 400, 9);
    expect(max20.ratio ?? 0).toBeLessThan(pro.ratio ?? 0);
  });

  it('carries the price date, the source and the per-seat flag through', () => {
    // A multiple with no date on its denominator cannot be audited later.
    const team = planUtilization(r, plans(), 'team');
    expect(team.perSeat).toBe(true);
    expect(team.priceDated).toBe(plans().dated);
    expect(team.priceSource).toBe(plans().source);
    expect(team.note).not.toBeNull();
  });

  it('throws rather than guessing at an unknown plan', () => {
    expect(() => planUtilization(r, plans(), 'ultra')).toThrow(/unknown plan/);
  });
});

describe('--plan on the CLI', () => {
  it('parses and normalises the id', () => {
    expect(parseArgs(['--plan', 'MAX5'], '/home').plan).toBe('max5');
    expect(parseArgs(['--plan=pro'], '/home').plan).toBe('pro');
  });

  it('defaults to no plan report', () => {
    expect(parseArgs([], '/home').plan).toBe('');
  });

  it('keeps an unsupported id verbatim rather than silently dropping it', () => {
    // main() resolves it against the price table and prints the supported ids.
    // Dropping it in parseArgs would produce a report with no plan section and
    // no explanation of why the flag did nothing.
    expect(parseArgs(['--plan', 'gpt-plus'], '/home').plan).toBe('gpt-plus');
  });
});

describe('the plan section in the HTML report', () => {
  const r = report(corpus());
  const withPlan = renderReport({ ...r, plan: planUtilization(r, plans(), 'pro') });

  it('prints the multiple and names what it was computed over', () => {
    expect(withPlan).toContain('1.88x');
    expect(withPlan).toContain('break-even multiple over whole months only');
  });

  it('states that this is not an invoice, above the number', () => {
    const framing = withPlan.indexOf('not an invoice and not a refund');
    const figure = withPlan.indexOf('1.88x');
    expect(framing).toBeGreaterThan(-1);
    expect(framing).toBeLessThan(figure);
  });

  it('labels every partial month in its own row', () => {
    expect(withPlan).toContain('4.0 of 31 days');
    expect(withPlan).toContain('only partly covered');
  });

  it('discloses the undated usage it could not place', () => {
    expect(withPlan).toContain('could not be placed in any month');
  });

  it('says the plan price is a vendor fact and dates it', () => {
    expect(withPlan).toContain('vendor fact, not a measurement');
    expect(withPlan).toContain(plans().dated);
  });

  it('refuses a multiple in the HTML too when no month is complete', () => {
    const week = report([session('a', ms('2026-06-04T00:00:00Z'), ms('2026-06-11T00:00:00Z'))]);
    const html = renderReport({ ...week, plan: planUtilization(week, plans(), 'pro') });
    expect(html).toContain('no break-even multiple can be computed');
    expect(html).not.toMatch(/[\d.]+x<\/div><div class="k">break-even/);
  });

  it('references no external host even though it cites a URL', () => {
    // The citation is evidence and stays; its scheme does not, so the
    // zero-egress assertion in pipeline.test.ts holds for a plan report too.
    expect(withPlan).not.toMatch(/https?:\/\//);
    expect(withPlan).not.toMatch(/<script/i);
    expect(withPlan).toContain('claude.com/pricing');
  });
});

describe('the fixture corpus under --plan', () => {
  // Three days of transcripts in August 2026. This is the shape a first-time
  // user has, and the feature has to decline to answer rather than answer badly.
  const fixtures = scanAll(path.join(root, 'fixtures', 'projects'));
  const p = planUtilization(report(fixtures), plans(), 'max5');

  it('spans one month and calls it incomplete', () => {
    expect(p.months.map((m) => m.month)).toEqual(['2026-08']);
    expect(p.months[0]?.complete).toBe(false);
  });

  it('reports no break-even multiple from three days of data', () => {
    expect(p.completeMonths).toBe(0);
    expect(p.ratio).toBeNull();
  });
});

/**
 * A month nobody worked in still costs the subscriber the fee.
 *
 * `monthlyCosts` used to build its map by walking the dated session rows, so a
 * calendar month with no sessions in it produced no row at all — and
 * `planUtilization` then multiplied the fee by the number of rows that survived.
 * An idle February was therefore free, and the break-even multiple came out
 * too favourable by exactly the fee it skipped. That inverts this feature's own
 * stated invariant, which is that every choice breaks toward under-claiming.
 */
describe('idle months inside the corpus span', () => {
  // January: one session. February: nothing at all. March: one session, running
  // to the stroke of April so all three months are bracketed end to end.
  const gapped = report([
    session('jan', ms('2026-01-01T00:00:00Z'), ms('2026-01-01T01:00:00Z')),
    session('mar', ms('2026-03-31T00:00:00Z'), ms('2026-04-01T00:00:00Z')),
  ]);

  it('charges a month with zero sessions to the calendar, not to the rows', () => {
    expect(gapped.byMonth.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(gapped.byMonth.map((m) => m.usd)).toEqual([25, 0, 25]);
    expect(gapped.byMonth.map((m) => m.turns)).toEqual([1, 0, 1]);
    expect(gapped.byMonth.map((m) => m.sessions)).toEqual([1, 0, 1]);
  });

  it('marks the idle month complete, because the corpus brackets it', () => {
    // Coverage is a statement about the corpus SPAN. February is fully spanned;
    // that nothing happened in it is the finding, not a gap in the data.
    expect(gapped.byMonth.map((m) => m.complete)).toEqual([true, true, true]);
    expect(gapped.byMonth[1]?.daysCovered).toBeCloseTo(28, 9);
    expect(gapped.byMonth[1]?.daysInMonth).toBe(28);
  });

  it('pays the fee for the idle month in the break-even multiple', () => {
    // By hand: $50 of API-equivalent value across three whole months at $20 =
    // $60 of fees, so 0.833x — under break-even. Skipping February gives
    // $50 / $40 = 1.25x, which is 1.5x too generous and reads as a win.
    const p = planUtilization(gapped, plans(), 'pro');
    expect(p.completeMonths).toBe(3);
    expect(p.completeUsd).toBeCloseTo(50, 9);
    expect(p.completePlanUsd).toBeCloseTo(60, 9);
    expect(p.ratio).toBeCloseTo(50 / 60, 9);
    expect(p.ratio ?? 0).toBeLessThan(1);
  });

  it('adds no month past the end of the corpus', () => {
    // The corpus ends at the exact instant April begins, so April is spanned for
    // zero days. A zero-day row would be charged a full month's fee.
    expect(gapped.byMonth.some((m) => m.month === '2026-04')).toBe(false);
  });

  it('still emits nothing at all for a corpus with no dated session', () => {
    expect(report([session('undated', null, null)]).byMonth).toEqual([]);
  });
});
