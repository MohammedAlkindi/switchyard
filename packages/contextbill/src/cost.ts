import type {
  CacheTtl,
  CostBreakdown,
  ModelPrice,
  ModelUsage,
  PriceEraAssumption,
  PriceTable,
  RatePeriod,
  RawUsage,
} from './types.js';

const PER_MILLION = 1_000_000;

/** Empty accumulator. */
export function zeroUsage(): RawUsage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

export function addUsage(a: RawUsage, b: RawUsage): RawUsage {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

export function zeroCost(): CostBreakdown {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

/**
 * Normalize a model id as it appears in a transcript to a key in the price table.
 *
 * Transcripts record whatever id was actually sent, and that includes dated
 * snapshot suffixes the current API docs tell you not to write by hand — real
 * example from a live corpus: `claude-haiku-4-5-20251001`. A lookup that misses
 * these prices a real model at zero and silently understates the bill, so the
 * date suffix is stripped before lookup.
 *
 * Vertex-style `@`-versioned ids (`claude-opus-4-5@20251101`) are handled too.
 */
export function normalizeModelId(model: string): string {
  const at = model.indexOf('@');
  const base = at === -1 ? model : model.slice(0, at);
  return base.replace(/-\d{8}$/, '');
}

/** Resolve the cache-write multiplier for a TTL, falling back to the 5m rate. */
export function cacheWriteMultiplier(table: PriceTable, ttl: CacheTtl): number {
  const raw = table.cacheWriteMultiplier[ttl];
  return typeof raw === 'number' ? raw : 1.25;
}

/**
 * The rate applied to one model's usage, and where it came from.
 *
 * `from` names the dated period used, or is null for a model carrying a single
 * flat rate. `assumedEarliest` is the honest half: true when the turn predates
 * every period in the table, so the earliest known rate was applied because
 * there is nothing earlier to apply. Callers surface that the way the cache-TTL
 * default is surfaced, rather than letting a guess read as a measurement.
 */
export interface RateInForce {
  input: number;
  output: number;
  /** `undefined` rather than optional-absent: a period may drop a fast tier. */
  fastInput: number | undefined;
  fastOutput: number | undefined;
  from: string | null;
  assumedEarliest: boolean;
}

/** Epoch ms for a `YYYY-MM-DD` period start, or NaN when it will not parse. */
function periodStart(from: string): number {
  return Date.parse(`${from}T00:00:00Z`);
}

function fromPeriod(period: RatePeriod, assumedEarliest: boolean): RateInForce {
  return {
    input: period.input,
    output: period.output,
    fastInput: period.fastInput,
    fastOutput: period.fastOutput,
    from: period.from,
    assumedEarliest,
  };
}

/**
 * Pick the rate a model was charged at on a given date.
 *
 * This is the whole point of dated periods: repricing last quarter's usage at
 * this quarter's rates makes an old report silently change value when a vendor
 * moves a price, and nothing about that failure throws.
 *
 * Three cases, and each is a deliberate choice rather than a fallthrough:
 *
 * - **No periods.** The flat rate is treated as having applied for all time.
 *   Every entry in `prices.json` is this case today, so behaviour is unchanged.
 * - **`at` is null.** The turn carries no timestamp, so the CURRENT rate applies
 *   — the latest period. That is what this tool did before periods existed, and
 *   moving undated usage onto some older rate would change numbers on the
 *   strength of no evidence at all.
 * - **`at` predates every period.** The earliest known rate applies and
 *   `assumedEarliest` is set, so the caller can report it. Pricing that usage at
 *   zero, or dropping it, would understate a real bill.
 *
 * Period order in the file is not trusted: the rate is chosen by date, so a
 * hand-edit that lands a period out of order cannot change what anything costs.
 * A period whose `from` will not parse is ignored rather than guessed at.
 */
export function rateInForce(price: ModelPrice, at: number | null): RateInForce {
  const flat: RateInForce = {
    input: price.input,
    output: price.output,
    fastInput: price.fastInput,
    fastOutput: price.fastOutput,
    from: null,
    assumedEarliest: false,
  };

  const periods = price.periods;
  if (periods === undefined || periods.length === 0) return flat;

  let latest: RatePeriod | undefined;
  let latestStart = Number.NEGATIVE_INFINITY;
  let earliest: RatePeriod | undefined;
  let earliestStart = Number.POSITIVE_INFINITY;
  let current: RatePeriod | undefined;
  let currentStart = Number.NEGATIVE_INFINITY;

  for (const period of periods) {
    const start = periodStart(period.from);
    if (Number.isNaN(start)) continue;
    if (start > latestStart) {
      latest = period;
      latestStart = start;
    }
    if (start < earliestStart) {
      earliest = period;
      earliestStart = start;
    }
    if (at !== null && start <= at && start > currentStart) {
      current = period;
      currentStart = start;
    }
  }

  // Every period carried an unparseable date. The flat rate is the only thing
  // left that is known to be a real rate.
  if (latest === undefined || earliest === undefined) return flat;

  if (at === null) return fromPeriod(latest, false);
  if (current !== undefined) return fromPeriod(current, false);
  return fromPeriod(earliest, true);
}

/** Price one entry, keeping the rate that was used so callers can report it. */
function priceEntry(
  entry: ModelUsage,
  table: PriceTable,
  ttl: CacheTtl,
  at: number | null,
): { cost: CostBreakdown; rate: RateInForce } | null {
  const key = normalizeModelId(entry.model);
  const price: ModelPrice | undefined = table.models[key];
  if (!price) return null;

  const rate = rateInForce(price, at);
  const fast = entry.speed === 'fast';
  const inRate = fast && rate.fastInput !== undefined ? rate.fastInput : rate.input;
  const outRate = fast && rate.fastOutput !== undefined ? rate.fastOutput : rate.output;

  const cw = cacheWriteMultiplier(table, ttl);
  const cr = table.cacheReadMultiplier;
  const u = entry.usage;

  const input = (u.input / PER_MILLION) * inRate;
  const cacheWrite = (u.cacheWrite / PER_MILLION) * inRate * cw;
  const cacheRead = (u.cacheRead / PER_MILLION) * inRate * cr;
  const output = (u.output / PER_MILLION) * outRate;

  return {
    cost: { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output },
    rate,
  };
}

/**
 * Price one model's usage at the rate in force when it happened.
 *
 * `at` defaults to the entry's own timestamp and is null when it carries none,
 * which is every entry today — see `rateInForce` for what each case does. The
 * parameter is there so a caller holding a better timestamp than the bucket does
 * can pass it without rebuilding the entry.
 *
 * Returns null when the model carries no rate — callers must surface that
 * rather than fold it in as zero, or the total quietly under-reports.
 */
export function priceModelUsage(
  entry: ModelUsage,
  table: PriceTable,
  ttl: CacheTtl,
  at: number | null = entry.at ?? null,
): CostBreakdown | null {
  return priceEntry(entry, table, ttl, at)?.cost ?? null;
}

export interface PricedTotals {
  cost: CostBreakdown;
  /** Model ids encountered that had no entry in the price table. */
  unpriced: string[];
  /**
   * Usage priced at the earliest rate known for its model because its timestamp
   * predates every dated period in the table.
   *
   * Empty unless the table carries dated periods AND the usage carries
   * timestamps, so it is empty on every corpus today. It exists so the fallback
   * is stated the way the cache-TTL assumption is stated in the report footer,
   * rather than being a silent guess folded into a total. Wiring it into
   * `Report` and that footer is a change to `aggregate.ts` and `report.ts`.
   */
  eraAssumptions: PriceEraAssumption[];
}

/** Price a list of per-model usage entries, collecting anything unpriceable. */
export function priceAll(
  entries: readonly ModelUsage[],
  table: PriceTable,
  ttl: CacheTtl,
): PricedTotals {
  let cost = zeroCost();
  const unpriced = new Set<string>();
  const assumed = new Map<string, PriceEraAssumption>();

  for (const entry of entries) {
    const priced = priceEntry(entry, table, ttl, entry.at ?? null);
    if (priced === null) {
      unpriced.add(entry.model);
      continue;
    }
    cost = addCost(cost, priced.cost);

    if (priced.rate.assumedEarliest && priced.rate.from !== null && entry.at != null) {
      const model = normalizeModelId(entry.model);
      const key = `${model} @ ${priced.rate.from}`;
      const seen = assumed.get(key);
      if (seen === undefined) {
        assumed.set(key, {
          model,
          entries: 1,
          turns: entry.turns,
          earliestAt: entry.at,
          appliedFrom: priced.rate.from,
        });
      } else {
        seen.entries += 1;
        seen.turns += entry.turns;
        seen.earliestAt = Math.min(seen.earliestAt, entry.at);
      }
    }
  }

  const eraAssumptions = [...assumed.values()].sort(
    (a, b) => a.model.localeCompare(b.model) || a.appliedFrom.localeCompare(b.appliedFrom),
  );

  return { cost, unpriced: [...unpriced].sort(), eraAssumptions };
}

/** USD formatted for humans. Sub-cent amounts keep enough digits to be checkable. */
export function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
