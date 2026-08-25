import type {
  CacheTtl,
  CostBreakdown,
  ModelPrice,
  ModelUsage,
  PriceTable,
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
 * Price one model's usage.
 *
 * Returns null when the model carries no rate — callers must surface that
 * rather than fold it in as zero, or the total quietly under-reports.
 */
export function priceModelUsage(
  entry: ModelUsage,
  table: PriceTable,
  ttl: CacheTtl,
): CostBreakdown | null {
  const key = normalizeModelId(entry.model);
  const price: ModelPrice | undefined = table.models[key];
  if (!price) return null;

  const fast = entry.speed === 'fast';
  const inRate = fast && price.fastInput !== undefined ? price.fastInput : price.input;
  const outRate = fast && price.fastOutput !== undefined ? price.fastOutput : price.output;

  const cw = cacheWriteMultiplier(table, ttl);
  const cr = table.cacheReadMultiplier;
  const u = entry.usage;

  const input = (u.input / PER_MILLION) * inRate;
  const cacheWrite = (u.cacheWrite / PER_MILLION) * inRate * cw;
  const cacheRead = (u.cacheRead / PER_MILLION) * inRate * cr;
  const output = (u.output / PER_MILLION) * outRate;

  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output };
}

export interface PricedTotals {
  cost: CostBreakdown;
  /** Model ids encountered that had no entry in the price table. */
  unpriced: string[];
}

/** Price a list of per-model usage entries, collecting anything unpriceable. */
export function priceAll(
  entries: readonly ModelUsage[],
  table: PriceTable,
  ttl: CacheTtl,
): PricedTotals {
  let cost = zeroCost();
  const unpriced = new Set<string>();

  for (const entry of entries) {
    const priced = priceModelUsage(entry, table, ttl);
    if (priced === null) {
      unpriced.add(entry.model);
      continue;
    }
    cost = addCost(cost, priced);
  }

  return { cost, unpriced: [...unpriced].sort() };
}

/** USD formatted for humans. Sub-cent amounts keep enough digits to be checkable. */
export function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
