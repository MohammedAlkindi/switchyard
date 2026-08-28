import { addCost, addUsage, normalizeModelId, priceAll, zeroCost, zeroUsage } from './cost.js';
import { buildFindings } from './waste.js';
import type {
  CacheTtl,
  CategoryCost,
  CostBreakdown,
  PriceTable,
  Report,
  SessionCost,
  SessionStat,
} from './types.js';

const PER_MILLION = 1_000_000;
const DAY_MS = 86_400_000;

/**
 * The input rate to charge a session's startup prefix at.
 *
 * A session can span several models, but the prefix is loaded once by whichever
 * model the session actually ran on. Using the model with the most turns is a
 * good approximation and, unlike a blend, it is a rate that genuinely exists in
 * the price table.
 */
function dominantInputRate(stat: SessionStat, table: PriceTable): number {
  let best: { turns: number; rate: number } | null = null;
  for (const entry of stat.byModel) {
    const price = table.models[normalizeModelId(entry.model)];
    if (!price) continue;
    const fast = entry.speed === 'fast';
    const rate = fast && price.fastInput !== undefined ? price.fastInput : price.input;
    if (!best || entry.turns > best.turns) best = { turns: entry.turns, rate };
  }
  return best?.rate ?? 0;
}

/**
 * What a session paid for its startup prefix.
 *
 * The prefix is written to cache once and then re-read on every subsequent
 * turn, so a 200-turn session pays for it 200 times. This is the calculation
 * that makes the fixed cost visible, and it mirrors the reference engine's
 * `instrEff` exactly — only denominated in dollars instead of weighted tokens.
 */
export function startupPrefixCost(
  stat: SessionStat,
  table: PriceTable,
  cacheWriteMult: number,
): number {
  if (stat.isSubagent || stat.startupPrefix <= 0 || stat.turns <= 0) return 0;
  const rate = dominantInputRate(stat, table);
  if (rate === 0) return 0;
  const perMillion = stat.startupPrefix / PER_MILLION;
  const write = perMillion * rate * cacheWriteMult;
  const rereads = perMillion * rate * table.cacheReadMultiplier * Math.max(0, stat.turns - 1);
  return write + rereads;
}

export interface AggregateOptions {
  table: PriceTable;
  ttl: CacheTtl;
  cacheWriteMult: number;
  topN?: number;
}

export function aggregate(stats: readonly SessionStat[], opts: AggregateOptions): Report {
  const { table, ttl, cacheWriteMult } = opts;
  const topN = opts.topN ?? 20;

  let cost = zeroCost();
  let usage = zeroUsage();
  let turns = 0;
  let startupPrefixUsd = 0;

  const modelTotals = new Map<string, { usd: number; turns: number }>();
  const projectTotals = new Map<
    string,
    { usd: number; turns: number; sessions: number; transcripts: number; prefixUsd: number }
  >();
  const categoryBytes = new Map<string, number>();
  const connectorBytes = new Map<string, number>();
  const connectorCalls = new Map<string, number>();
  const unpricedSeen = new Set<string>();
  const sessions: SessionCost[] = [];

  let contentUsd = 0;
  let earliest: number | null = null;
  let latest: number | null = null;

  for (const stat of stats) {
    const priced = priceAll(stat.byModel, table, ttl);
    for (const m of priced.unpriced) unpricedSeen.add(m);

    cost = addCost(cost, priced.cost);
    usage = addUsage(usage, stat.usage);
    turns += stat.turns;

    for (const entry of stat.byModel) {
      const key = normalizeModelId(entry.model) + (entry.speed === 'fast' ? ' (fast)' : '');
      const acc = modelTotals.get(key) ?? { usd: 0, turns: 0 };
      const single = priceAll([entry], table, ttl);
      acc.usd += single.cost.total;
      acc.turns += entry.turns;
      modelTotals.set(key, acc);
    }

    // The prefix figure is a MODEL (tokens x rate x re-reads), not a billed
    // line item, so it can overshoot what the session actually paid — a short
    // session whose cache expired is the common case. Cap it at all non-output
    // spend, which is the most it could possibly have been. Without this cap
    // the overshoot leaks into the category table and shares sum above 100%.
    const nonOutputUsd = Math.max(0, priced.cost.total - priced.cost.output);
    const prefixUsd = Math.min(startupPrefixCost(stat, table, cacheWriteMult), nonOutputUsd);
    startupPrefixUsd += prefixUsd;

    // Everything that is neither fixed prefix nor generated output is
    // conversation content, apportioned across tool categories by bytes read
    // back into context. Exact by construction now that the prefix is capped.
    contentUsd += nonOutputUsd - prefixUsd;

    // Accumulated from the same per-session values as the corpus totals above,
    // which is what makes the project rows sum back to the whole exactly —
    // including the prefix, because prefixUsd is capped before it lands here.
    const proj = projectTotals.get(stat.project) ?? {
      usd: 0,
      turns: 0,
      sessions: 0,
      transcripts: 0,
      prefixUsd: 0,
    };
    proj.usd += priced.cost.total;
    proj.turns += stat.turns;
    proj.transcripts += 1;
    if (!stat.isSubagent) proj.sessions += 1;
    proj.prefixUsd += prefixUsd;
    projectTotals.set(stat.project, proj);

    for (const [category, bytes] of Object.entries(stat.toolBytes)) {
      if (typeof bytes !== 'number') continue;
      categoryBytes.set(category, (categoryBytes.get(category) ?? 0) + bytes);
    }

    for (const [server, bytes] of Object.entries(stat.connectorBytes)) {
      connectorBytes.set(server, (connectorBytes.get(server) ?? 0) + bytes);
    }
    for (const [server, calls] of Object.entries(stat.connectorCalls)) {
      connectorCalls.set(server, (connectorCalls.get(server) ?? 0) + calls);
    }

    if (stat.startedAt !== null) {
      earliest = earliest === null ? stat.startedAt : Math.min(earliest, stat.startedAt);
    }
    if (stat.endedAt !== null) {
      latest = latest === null ? stat.endedAt : Math.max(latest, stat.endedAt);
    }

    if (!stat.isSubagent) {
      sessions.push({
        id: stat.id,
        project: stat.project,
        turns: stat.turns,
        usd: priced.cost.total,
        usdPerTurn: stat.turns > 0 ? priced.cost.total / stat.turns : 0,
        producedFile: stat.producedFile,
        startupPrefix: stat.startupPrefix,
        startedAt: stat.startedAt,
        bytes: stat.bytes,
      });
    }
  }

  const totalBytes = [...categoryBytes.values()].reduce((a, b) => a + b, 0);
  const byCategory: CategoryCost[] = [];
  if (totalBytes > 0) {
    for (const [category, bytes] of categoryBytes) {
      byCategory.push({ category, usd: contentUsd * (bytes / totalBytes), share: 0 });
    }
  }
  byCategory.push({ category: 'startup prefix (fixed, every turn)', usd: startupPrefixUsd, share: 0 });
  byCategory.push({ category: 'model output', usd: cost.output, share: 0 });
  for (const row of byCategory) {
    row.share = cost.total > 0 ? (100 * row.usd) / cost.total : 0;
  }
  byCategory.sort((a, b) => b.usd - a.usd);

  const byModel = [...modelTotals.entries()]
    .map(([model, v]) => ({
      model,
      usd: v.usd,
      turns: v.turns,
      share: cost.total > 0 ? (100 * v.usd) / cost.total : 0,
    }))
    .sort((a, b) => b.usd - a.usd);

  const byProject = [...projectTotals.entries()]
    .map(([project, v]) => ({
      project,
      usd: v.usd,
      share: cost.total > 0 ? (100 * v.usd) / cost.total : 0,
      turns: v.turns,
      sessions: v.sessions,
      transcripts: v.transcripts,
      startupPrefixUsd: v.prefixUsd,
    }))
    .sort((a, b) => b.usd - a.usd);

  // Priced off the same content pool and the same denominator as the category
  // rows, so a connector's dollars are directly comparable with them. Servers
  // that were called but returned nothing still appear, with their call count
  // and $0 — a chatty connector and a silent one are different findings.
  const byConnector = [...new Set([...connectorBytes.keys(), ...connectorCalls.keys()])]
    .map((server) => {
      const bytes = connectorBytes.get(server) ?? 0;
      const usd = totalBytes > 0 ? contentUsd * (bytes / totalBytes) : 0;
      return {
        server,
        usd,
        share: cost.total > 0 ? (100 * usd) / cost.total : 0,
        calls: connectorCalls.get(server) ?? 0,
        bytes,
      };
    })
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls);

  const topSessions = [...sessions].sort((a, b) => b.usd - a.usd).slice(0, topN);

  const spanDays =
    earliest !== null && latest !== null && latest > earliest
      ? Math.max(1, (latest - earliest) / DAY_MS)
      : 1;

  return {
    generatedAt: new Date().toISOString(),
    priceTableDate: table.dated,
    cacheTtlAssumed: ttl,
    transcriptCount: stats.length,
    sessionCount: sessions.length,
    turns,
    usage,
    cost,
    byModel,
    byCategory,
    byProject,
    byConnector,
    topSessions,
    findings: buildFindings(stats, sessions, startupPrefixUsd),
    unpricedModelsSeen: [...unpricedSeen].sort(),
    spanDays,
  };
}

/** Straight-line monthly projection from the corpus span. */
export function monthlyProjection(report: Report): number {
  return (report.cost.total / report.spanDays) * 30;
}

export type { CostBreakdown };
