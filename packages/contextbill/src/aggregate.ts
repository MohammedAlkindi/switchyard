import { addCost, addUsage, normalizeModelId, priceAll, zeroCost, zeroUsage } from './cost.js';
import { buildFindings } from './waste.js';
import type {
  CacheTtl,
  CategoryCost,
  CostBreakdown,
  DeduplicationStats,
  MonthCost,
  PlanMonth,
  PlanPrice,
  PlanTable,
  PlanUtilization,
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
 *
 * Turns are totalled per model and speed BEFORE the comparison, because
 * `byModel` carries one row per model per UTC day. Comparing rows directly
 * would let a model that ran 35 turns in a single day outrank one that ran 90
 * across three, and hand the whole session's fixed context the wrong rate.
 */
function dominantInputRate(stat: SessionStat, table: PriceTable): number {
  const perModel = new Map<string, { turns: number; rate: number }>();
  for (const entry of stat.byModel) {
    const id = normalizeModelId(entry.model);
    const price = table.models[id];
    if (!price) continue;
    const fast = entry.speed === 'fast';
    const rate = fast && price.fastInput !== undefined ? price.fastInput : price.input;
    const key = `${id}${fast ? ' (fast)' : ''}`;
    const acc = perModel.get(key) ?? { turns: 0, rate };
    acc.turns += entry.turns;
    perModel.set(key, acc);
  }

  let best: { turns: number; rate: number } | null = null;
  for (const acc of perModel.values()) {
    if (!best || acc.turns > best.turns) best = acc;
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
 *
 * `stat.turns` is the count of distinct billed messages, not of transcript
 * lines. That distinction is what makes the multiplier below right: a streamed
 * rewrite restates a message that was already sent, so it is not another
 * request and does not re-read the prefix. Counting lines here charged the
 * fixed context two to three times over.
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

/**
 * Count what the per-transcript deduplication removed, and what it left behind.
 *
 * The cross-file half is the point. `parse.ts` scopes its id map to one file,
 * so a resumed session that copied its parent's history is still counted twice.
 * That is deliberate — merging across files would need evidence this codebase
 * does not have — but an uncounted double-count is indistinguishable from a
 * correct total, so it is measured here and stated in the report.
 *
 * The residual is reported in DOLLARS as well as in ids, and takes `usdPerTurn`
 * for each transcript to do it. A count of message ids cannot be read as a share
 * of a bill, and the disclosure exists precisely so a reader can size the error
 * that was left in. Per-message dollars do not survive aggregation — usage is
 * summed per model before it is priced — so each duplicated message is valued at
 * the mean cost per turn of the transcripts holding it, and all but one copy of
 * each id is charged as redundant. That is an estimate and is labelled as one.
 */
function deduplicationStats(
  stats: readonly SessionStat[],
  usdPerTurn: ReadonlyMap<SessionStat, number>,
): DeduplicationStats {
  const holdersPerId = new Map<string, SessionStat[]>();
  let rewritesCollapsed = 0;
  let unidentifiedRecords = 0;

  for (const stat of stats) {
    rewritesCollapsed += stat.usageRewrites;
    unidentifiedRecords += stat.unidentifiedUsage;
    for (const id of stat.messageIds) {
      const holders = holdersPerId.get(id);
      if (holders === undefined) holdersPerId.set(id, [stat]);
      else holders.push(stat);
    }
  }

  const shared = new Set<string>();
  let duplicatedTurns = 0;
  let duplicatedUsd = 0;
  for (const [id, holders] of holdersPerId) {
    if (holders.length <= 1) continue;
    shared.add(id);
    duplicatedTurns += holders.length - 1;
    const mean = holders.reduce((n, s) => n + (usdPerTurn.get(s) ?? 0), 0) / holders.length;
    duplicatedUsd += mean * (holders.length - 1);
  }

  let transcriptsSharingHistory = 0;
  if (shared.size > 0) {
    for (const stat of stats) {
      if (stat.messageIds.some((id) => shared.has(id))) transcriptsSharingHistory += 1;
    }
  }

  return {
    rewritesCollapsed,
    unidentifiedRecords,
    sharedMessageIds: shared.size,
    transcriptsSharingHistory,
    duplicatedTurns,
    duplicatedUsd,
  };
}

/** `YYYY-MM` in UTC for an epoch-ms instant. */
function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First instant of a `YYYY-MM` month, UTC. */
function monthStart(key: string): number {
  return Date.parse(`${key}-01T00:00:00Z`);
}

/**
 * First instant of the month AFTER a `YYYY-MM` key, UTC.
 *
 * Built from `Date.UTC` with a month index one past the end rather than by
 * adding 30 days: month lengths differ, and a fixed-length month makes February
 * look permanently incomplete and December permanently over-covered.
 */
function nextMonthStart(key: string): number {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  return Date.UTC(year, month, 1);
}

/**
 * Cost per calendar month, with how much of each month the corpus can see.
 *
 * The coverage half is what stops a monthly figure from reading as a full
 * month's spend. A corpus begins at its oldest surviving transcript and ends at
 * its newest, so both end months are partial, and the month in progress always
 * is. `daysCovered` is the overlap between the corpus span and the calendar
 * month, and `complete` is true only when the corpus brackets the whole month.
 *
 * Coverage is a statement about the corpus SPAN, not about the transcripts
 * inside it. A month whose middle week was deleted still reads complete; there
 * is nothing in a transcript directory that can distinguish a quiet week from a
 * pruned one, and inventing a gap detector would be a guess dressed as a
 * measurement.
 *
 * The month list comes from the CALENDAR, not from the rows. Walking the rows
 * alone drops any month nobody worked in, and `planUtilization` then multiplies
 * the subscription fee by the number of months that survived — so an idle month
 * inside the span came out free and the break-even multiple came out too
 * favourable. A subscriber pays for February whether or not they opened a
 * session in it. A month with no rows is reported with zeroes, which is the
 * finding rather than the absence of one.
 */
function monthlyCosts(
  rows: readonly { at: number; usd: number; turns: number; isSubagent: boolean }[],
  corpusStart: number | null,
  corpusEnd: number | null,
): MonthCost[] {
  const totals = new Map<string, { usd: number; turns: number; sessions: number }>();
  const blank = (key: string): { usd: number; turns: number; sessions: number } => {
    const existing = totals.get(key);
    if (existing !== undefined) return existing;
    const fresh = { usd: 0, turns: 0, sessions: 0 };
    totals.set(key, fresh);
    return fresh;
  };

  // Every month the corpus spans, including the ones with nothing in them. The
  // walk stops at the month the corpus ends IN: a month whose first instant is
  // not before `corpusEnd` is spanned for zero days, and a zero-day month would
  // be charged a whole month's fee. Bounded so a corrupt far-future timestamp
  // produces a wrong report rather than a hanging one.
  if (corpusStart !== null && corpusEnd !== null) {
    let year = new Date(corpusStart).getUTCFullYear();
    let month = new Date(corpusStart).getUTCMonth();
    for (let guard = 0; guard < 1200; guard += 1) {
      const start = Date.UTC(year, month, 1);
      if (start >= corpusEnd && guard > 0) break;
      blank(`${String(year)}-${String(month + 1).padStart(2, '0')}`);
      month += 1;
      if (month === 12) {
        month = 0;
        year += 1;
      }
    }
  }

  for (const row of rows) {
    const acc = blank(monthKey(row.at));
    acc.usd += row.usd;
    acc.turns += row.turns;
    if (!row.isSubagent) acc.sessions += 1;
  }

  return [...totals.entries()]
    .map(([month, v]) => {
      const start = monthStart(month);
      const end = nextMonthStart(month);
      const daysInMonth = (end - start) / DAY_MS;
      const from = corpusStart === null ? start : Math.max(corpusStart, start);
      const to = corpusEnd === null ? end : Math.min(corpusEnd, end);
      const daysCovered = Math.max(0, Math.min(to - from, end - start)) / DAY_MS;
      return {
        month,
        usd: v.usd,
        turns: v.turns,
        sessions: v.sessions,
        daysCovered,
        daysInMonth,
        complete:
          corpusStart !== null && corpusEnd !== null && corpusStart <= start && corpusEnd >= end,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Value a subscription returned, against what the subscription cost.
 *
 * Pure, and separate from `aggregate` because it needs a plan id the user
 * supplies — a report without `--plan` is complete without any of this.
 *
 * Two rules do all the work of keeping the headline honest:
 *
 * 1. **The multiple is computed over complete months only, or not at all.** A
 *    corpus of three weeks against a full month's fee produces a multiple that
 *    is wrong by whatever fraction is missing, and it is wrong in the direction
 *    that looks like modesty rather than error, which is worse. When no month
 *    is complete the ratio is null and the caller says so.
 * 2. **A metered plan gets no multiple at all.** There is no flat fee to divide
 *    by; printing 1.0 would invent a break-even that does not exist.
 * 3. **Every month in the span is charged, including the idle ones.** The fee is
 *    paid whether or not a session was opened, so `report.byMonth` carries a
 *    zero-usage row for a month nobody worked in and `complete.length` counts
 *    it. Counting only months with sessions in them made an idle month free and
 *    inflated the multiple — the one direction this feature must never err in.
 *
 * Throws only on an unknown plan id — the caller resolves that against the
 * table and reports the supported ids, which is a better message than anything
 * available here.
 */
export function planUtilization(report: Report, plans: PlanTable, id: string): PlanUtilization {
  const entry: PlanPrice | undefined = plans.entries[id];
  if (entry === undefined) {
    throw new Error(`unknown plan "${id}"`);
  }

  const metered = entry.billing === 'metered';
  const usdPerMonth = metered ? null : (entry.usdPerMonth ?? null);

  const months: PlanMonth[] = report.byMonth.map((m) => ({
    ...m,
    ratio: usdPerMonth !== null && usdPerMonth > 0 ? m.usd / usdPerMonth : null,
  }));

  const complete = months.filter((m) => m.complete);
  const completeUsd = complete.reduce((n, m) => n + m.usd, 0);
  const completePlanUsd = usdPerMonth === null ? null : usdPerMonth * complete.length;

  return {
    plan: id,
    label: entry.label,
    billing: entry.billing,
    usdPerMonth,
    usdPerMonthAnnual: entry.usdPerMonthAnnual ?? null,
    perSeat: entry.perSeat === true,
    priceDated: plans.dated,
    priceSource: plans.source,
    note: entry.note ?? null,
    months,
    completeMonths: complete.length,
    completeUsd,
    completePlanUsd,
    // Null on purpose when there is no complete month: a partial period cannot
    // produce a multiple anyone should act on, and a fraction of one is not a
    // conservative estimate, it is a different number.
    ratio:
      completePlanUsd !== null && completePlanUsd > 0 && complete.length > 0
        ? completeUsd / completePlanUsd
        : null,
    undatedUsd: report.undatedUsd,
  };
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

  // Collected per transcript and bucketed after the loop, because a month's
  // coverage cannot be known until the corpus span is. A transcript with no
  // timestamp lands in `undatedUsd` rather than in a guessed month.
  const dated: { at: number; usd: number; turns: number; isSubagent: boolean }[] = [];
  let undatedUsd = 0;

  // What one turn of each transcript cost, which is what prices the residual
  // cross-file double-count below. Built here because this is the only place a
  // transcript's dollars and its turn count are both in hand.
  const usdPerTurn = new Map<SessionStat, number>();

  for (const stat of stats) {
    const priced = priceAll(stat.byModel, table, ttl);
    for (const m of priced.unpriced) unpricedSeen.add(m);

    cost = addCost(cost, priced.cost);
    usage = addUsage(usage, stat.usage);
    turns += stat.turns;
    usdPerTurn.set(stat, stat.turns > 0 ? priced.cost.total / stat.turns : 0);

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

    // A session is attributed whole to the month it STARTED in. Splitting one
    // that crosses midnight on the last of the month would need per-turn
    // timestamps this aggregator does not carry; the approximation is stated in
    // the report rather than being invisible.
    if (stat.startedAt !== null) {
      dated.push({
        at: stat.startedAt,
        usd: priced.cost.total,
        turns: stat.turns,
        isSubagent: stat.isSubagent,
      });
      earliest = earliest === null ? stat.startedAt : Math.min(earliest, stat.startedAt);
    } else {
      undatedUsd += priced.cost.total;
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
    deduplication: deduplicationStats(stats, usdPerTurn),
    byMonth: monthlyCosts(dated, earliest, latest),
    undatedUsd,
  };
}

/** Straight-line monthly projection from the corpus span. */
export function monthlyProjection(report: Report): number {
  return (report.cost.total / report.spanDays) * 30;
}

export type { CostBreakdown };
