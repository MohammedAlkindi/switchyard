import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ModelPrice, PriceTable } from '../types.js';

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

/**
 * Per-provider dating, read from the raw JSON.
 *
 * `PriceTable` in types.ts declares one `dated` and one `source`, which was
 * true while every rate came from one vendor. It no longer is: OpenAI rates and
 * Anthropic rates move on different schedules and are read from different
 * pages, so each provider carries its own reading date — the same argument that
 * gives `plans` its own `dated`. Typed here rather than in types.ts because
 * nothing in `src/` reads it; only this file and a human auditor do.
 */
interface ProviderDated {
  dated: string;
  source: string;
}
interface DatedByProvider {
  datedByProvider?: Record<string, ProviderDated>;
}
const dating = JSON.parse(
  fs.readFileSync(path.join(root, 'prices.json'), 'utf8'),
) as PriceTable & DatedByProvider;

/** Model ids priced against OpenAI's published table. */
function openaiIds(t: PriceTable): string[] {
  return Object.keys(t.models).filter((id) => id.startsWith('gpt-'));
}

/**
 * Cached-input rates exactly as OpenAI prints them, read 2026-09-07 from
 * https://developers.openai.com/api/docs/pricing and each model's own page.
 *
 * Held here rather than in `prices.json` because the table has no per-model
 * cache field: `cacheReadMultiplier` is one global 0.1x. That global is only
 * safe for these entries because OpenAI's published cached rate happens to be
 * exactly a tenth of its input rate for every one of them. That is a
 * coincidence between two vendors, not a law, so it is written down and checked
 * rather than assumed — if OpenAI ever prints a cached rate that is not input/10,
 * this test fails and names the model instead of the report quietly repricing
 * every cache read in the corpus.
 */
const OPENAI_PUBLISHED_CACHED_INPUT: Record<string, number> = {
  'gpt-5.6-sol': 0.4,
  'gpt-5.6-terra': 0.2,
};

describe('prices.json: the OpenAI rates', () => {
  it('prices at least the Codex models the corpus actually contains', () => {
    // Not the whole OpenAI catalogue. A rate nobody's transcripts reference is
    // an unverifiable claim carried forever; these two are the models Codex
    // rollouts on this machine actually name.
    expect(openaiIds(table)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('names a source URL and a reading date on every OpenAI rate', () => {
    // THE POINT OF THIS FILE, applied to a second vendor. A rate written from
    // memory renders exactly like a rate read off a page, and nothing else in
    // the suite can tell them apart. Anthropic's rates are vouched for by the
    // table's own `source` and `dated`; an OpenAI rate cannot borrow that
    // vouching, so it carries its own and this test fails if one does not.
    const ids = openaiIds(table);
    expect(ids.length, 'no OpenAI rates to check — did the entries move?').toBeGreaterThan(0);
    for (const id of ids) {
      const note = table.models[id]?.note ?? '';
      expect(/https:\/\/\S+/.test(note), `models.${id}.note carries no source URL`).toBe(true);
      const read = /read (\d{4}-\d{2}-\d{2})/.exec(note);
      expect(read, `models.${id}.note does not say when the rate was read`).not.toBeNull();
      const at = Date.parse(`${read?.[1] ?? ''}T00:00:00Z`);
      expect(Number.isNaN(at), `models.${id}.note reading date will not parse`).toBe(false);
      expect(at, `models.${id}.note is dated in the future`).toBeLessThan(Date.now() + 86_400_000);
    }
  });

  it('dates and sources each provider separately', () => {
    // One date covering two vendors would let a fresh reading of one page vouch
    // for a page nobody opened. Same argument that gives `plans` its own date.
    const by = dating.datedByProvider;
    expect(by, 'prices.json needs datedByProvider once it prices two vendors').toBeDefined();
    if (by === undefined) return;
    for (const key of ['anthropic', 'openai']) {
      const entry = by[key];
      expect(entry, `datedByProvider.${key} is missing`).toBeDefined();
      if (entry === undefined) continue;
      const at = Date.parse(`${entry.dated}T00:00:00Z`);
      expect(Number.isNaN(at), `datedByProvider.${key}.dated will not parse`).toBe(false);
      expect(at, `datedByProvider.${key}.dated is in the future`).toBeLessThan(
        Date.now() + 86_400_000,
      );
      expect(
        entry.source.length,
        `datedByProvider.${key} carries no source to audit against`,
      ).toBeGreaterThan(20);
    }
  });

  it('keeps the table date at the OLDEST provider reading', () => {
    // The 60-day staleness test above reads `dated`. If `dated` tracked the
    // most recent provider read, adding a fresh OpenAI reading would reset the
    // clock on an Anthropic table nobody had looked at for months — the drift
    // check would go green by adding an unrelated vendor. Pinning `dated` to
    // the oldest reading makes that check guard the stalest half.
    const by = dating.datedByProvider;
    if (by === undefined) return;
    const dates = Object.values(by).map((p) => p.dated).sort();
    expect(table.dated, 'dated must equal the oldest per-provider reading').toBe(dates[0]);
  });

  it('confirms OpenAI cached input really is a tenth of its input rate', () => {
    // The global `cacheReadMultiplier` is what actually prices a cache read, so
    // if a published cached rate ever stops being input/10 the report starts
    // pricing the LARGEST token class on a Codex corpus at the wrong rate, with
    // nothing throwing. This is the check that notices.
    for (const [id, published] of Object.entries(OPENAI_PUBLISHED_CACHED_INPUT)) {
      const price = table.models[id];
      if (price === undefined) continue;
      expect(
        price.input * table.cacheReadMultiplier,
        `${id}: published cached ${published} != input ${price.input} x ${table.cacheReadMultiplier}`,
      ).toBeCloseTo(published, 10);
    }
  });

  it('leaves gpt-5.5 unpriced until the table can express its cache-write rate', () => {
    // gpt-5.5 DOES appear in real rollouts, so this is not an oversight — it is
    // recorded in the $comment-missing-gpt-5-5 block. OpenAI charges a 1.25x
    // cache-write premium on GPT-5.6 and later and NO premium before it, while
    // `cacheWriteMultiplier` is a single global with no per-model override.
    // Adding gpt-5.5 under that global would assert a premium OpenAI does not
    // charge. Unpriced, it is counted and reported loudly instead.
    //
    // Written as a conditional rather than a flat absence so it does not block
    // the correct fix: give a model entry its own cache multipliers, teach
    // cost.ts to prefer them, and this passes the moment gpt-5.5 carries one.
    const five = table.models['gpt-5.5'] as (ModelPrice & { cacheWriteMultiplier?: number }) | undefined;
    if (five === undefined) return;
    expect(
      typeof five.cacheWriteMultiplier,
      'gpt-5.5 is priced but carries no per-model cacheWriteMultiplier — its cache writes are billing at a premium OpenAI does not charge',
    ).toBe('number');
  });

  it('invents no dated period for a rate change it cannot evidence', () => {
    // Same rule the Anthropic half is held to: a period is a claim about what a
    // vendor charged on a date. gpt-5.6-sol's price is described as promotional
    // "at least through" a FUTURE date, which is not evidence of a PAST change,
    // so there is no earlier rate to write down. A period restating today's
    // numbers would put a rate into the history that was never charged.
    for (const id of openaiIds(table)) {
      expect(table.models[id]?.periods, `${id} carries a period with no evidenced change`).toBeUndefined();
    }
  });
});

describe('the OpenAI block does not restate codex-parse.ts more confidently than it', () => {
  // The token-field arithmetic is documented twice: once in `codex-parse.ts`,
  // which derived it, and once here, where a reader deciding whether a rate is
  // missing meets it. A restatement that drops a qualifier is worse than no
  // restatement, because it reads as the stronger of two sources while being
  // the one nobody re-measured.
  const raw = fs.readFileSync(path.join(root, 'prices.json'), 'utf8');
  const parser = fs.readFileSync(path.join(root, 'src', 'codex-parse.ts'), 'utf8');
  const block = ((JSON.parse(raw) as Record<string, unknown>)['$comment-openai'] ??
    []) as string[];
  const text = block.join(' ');

  it('carries the well-formed qualifier that codex-parse.ts carries', () => {
    expect(parser).toContain('well-formed');
    expect(text.toLowerCase()).toContain('well-formed');
  });

  it('does not claim the identity holds with no exceptions', () => {
    // Four `last_token_usage` records read input 0 / output 0 against a non-zero
    // total. They are dropped by the cumulative-advance gate before anything
    // reads them, which makes them harmless — not absent.
    expect(text).not.toMatch(/with 0 exceptions/);
    expect(text).toMatch(/FOUR records violate the identity/);
  });
});
