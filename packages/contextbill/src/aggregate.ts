import { addCost, addUsage, normalizeModelId, priceAll, zeroCost, zeroUsage } from './cost.js';
import { utcDayKey } from './parse.js';
import { buildFindings } from './waste.js';
import type {
  BilledMessage,
  CacheTtl,
  CategoryCost,
  CostBreakdown,
  DeduplicationStats,
  ModelUsage,
  MonthCost,
  PlanMonth,
  PlanPrice,
  PlanTable,
  PlanUtilization,
  PriceTable,
  RawUsage,
  Report,
  SessionCost,
  SessionStat,
} from './types.js';

const PER_MILLION = 1_000_000;
const DAY_MS = 86_400_000;

/**
 * Separator for the composite keys built below.
 *
 * U+0000 cannot occur inside a model id or a uuid, so the key is unambiguous.
 * `parse.ts` uses the same byte for the same reason; the two are never compared
 * with each other, so this is a parallel choice rather than a shared constant.
 * Written as an escape rather than a literal byte, which would make this file
 * read as binary to grep and diff.
 */
const KEY_SEP = '\u0000';

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
 * What one cross-file pass removed.
 *
 * `stats` is the corrected corpus, in the order it arrived. Everything else is
 * what the report says about the correction.
 */
export interface CrossFileMerge {
  stats: SessionStat[];
  /** Messages found in more than one transcript and proved to be copies. */
  messagesMerged: number;
  /** Redundant copies removed. Three holders of one message contribute two. */
  copiesMerged: number;
  /** Transcripts that lost at least one copy. */
  transcriptsCorrected: number;
  /**
   * The usage that came off the totals, bucketed by model, speed and UTC day so
   * it can be priced at its own rate rather than at a corpus average.
   *
   * NET, not gross. A merged message is valued at the maximum per field of every
   * holder, so when a dropped copy carries that maximum the surviving copy is
   * RAISED to it and those tokens never leave the corpus. They are subtracted
   * here. Pricing the dropped copies alone reported more removed than the totals
   * lost — up to the whole of a raise — under a label that calls the figure
   * exact. A row may therefore carry a negative field, which prices to a
   * negative amount because pricing is linear in tokens; the list is a delta,
   * not a corpus.
   */
  removed: ModelUsage[];
}

/** The identity a message is matched on across transcripts. See `BilledMessage`. */
function crossFileKey(msg: BilledMessage): string {
  return `${msg.id}${KEY_SEP}${msg.uuid}`;
}

/**
 * The `byModel` bucket a message was summed into, as `parse.ts` keys it.
 *
 * Every record in one bucket shares a UTC day, so deriving the key from the
 * message's own timestamp finds the row that message was summed into. Re-deriving
 * that boundary here is why `utcDayKey` is exported rather than reimplemented.
 */
function modelRowKey(model: string, speed: string, at: number | null): string {
  return `${model}${KEY_SEP}${speed}${KEY_SEP}${utcDayKey(at)}`;
}

function maxUsage(a: RawUsage, b: RawUsage): RawUsage {
  return {
    input: Math.max(a.input, b.input),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    output: Math.max(a.output, b.output),
  };
}

function negate(u: RawUsage): RawUsage {
  return { input: -u.input, cacheWrite: -u.cacheWrite, cacheRead: -u.cacheRead, output: -u.output };
}

/** Which of two transcripts keeps a message both of them hold. */
function outranks(a: SessionStat, b: SessionStat): boolean {
  const aAt = a.startedAt ?? Number.POSITIVE_INFINITY;
  const bAt = b.startedAt ?? Number.POSITIVE_INFINITY;
  if (aAt !== bAt) return aAt < bAt;
  if (a.id !== b.id) return a.id < b.id;
  return a.project < b.project;
}

/**
 * Count each billed message once across the whole corpus.
 *
 * A resumed session copies its parent's transcript lines forward, so the same
 * API request sits in two files and used to be counted twice. `parse.ts` cannot
 * see that — it reads one transcript — so the correction has to happen here,
 * where every transcript is in hand. It runs before anything is priced, and the
 * CLI and the browser both reach it through `aggregate`, which is what keeps the
 * two surfaces reporting the same number for the same directory.
 *
 * WHAT IS MERGED, and why merging on `message.id` alone would be wrong. Measured
 * over a frozen copy of 2,355 real transcripts (443,478 lines, 166,027 of them
 * usage-bearing) on 2026-09-08: 70,511 distinct message ids, of which 1,397
 * appear in more than one file, across 51 transcripts. Two unrelated things
 * produce that.
 *
 *  - A resume. The copied lines keep their `uuid`: 1,394 of the 1,397 have a
 *    byte-identical FIRST uuid in every holder, and 1,386 have identical uuid
 *    SETS. `sessionId` is NOT usable — it is rewritten to the new session on
 *    every copied line, so it differed across holders for 1,384 of the 1,397
 *    while the uuid did not.
 *  - An id whose holders share no uuid at all. Three ids, all sibling subagent
 *    transcripts of one parent session, and inspecting the lines shows one
 *    message's streamed rewrites scattered across those files — the same request.
 *    Merging those would be RIGHT, and there is no way to tell them apart from
 *    the case where merging is wrong: an API gateway handing one id to two
 *    genuinely independent sessions produces the same shape, and merging THAT
 *    under-counts real spend.
 *
 * So the rule is `message.id` AND the first `uuid` must both match. A uuid is
 * minted per line by whoever wrote the line, so two files sharing one is proof
 * of a copy; not sharing one is proof of nothing. The unproved cases stay
 * counted and are disclosed as the residual — an overstatement that is measured
 * beats an understatement that is invisible.
 *
 * WHAT IS NOT TOUCHED. `startupPrefix` stays as parsed, including on a session
 * whose first message this pass just took away. The prefix is the fixed context
 * every turn of that session re-reads, and the copied first message is an honest
 * witness of it; re-deriving it from the first message the session wrote itself
 * would read a mid-conversation cache read as startup context and inflate the
 * figure by the whole parent transcript. `bytes`, `toolBytes`, `connectorBytes`
 * and the tool counters stay too: those bytes really were read back into that
 * session's context window.
 *
 * ATTRIBUTION IS ARBITRARY, the total is not. A verbatim copy carries the
 * parent's timestamps, so parent and child usually start at the same instant and
 * nothing in either file says which one made the request. The message goes to
 * the earliest-starting holder, tie-broken by session id then project —
 * deterministic, order independent, and identical in both readers, but a
 * coin-toss between holders all the same. It moves dollars between rows of
 * `topSessions` and `byProject`; it cannot move the corpus total, which is exact.
 */
export function mergeResumedCopies(stats: readonly SessionStat[]): CrossFileMerge {
  const holders = new Map<string, { stat: SessionStat; msg: BilledMessage }[]>();
  for (const stat of stats) {
    for (const msg of stat.billedMessages ?? []) {
      const key = crossFileKey(msg);
      const group = holders.get(key);
      if (group === undefined) holders.set(key, [{ stat, msg }]);
      else group.push({ stat, msg });
    }
  }

  // Per transcript: the copies it loses, and the raise its own copy takes.
  const drops = new Map<SessionStat, BilledMessage[]>();
  const raises = new Map<SessionStat, Map<string, RawUsage>>();
  const removedRows = new Map<string, ModelUsage>();
  let messagesMerged = 0;
  let copiesMerged = 0;

  // `removed` is the NET of the merge, and both halves have to land in it or the
  // figure the report prints as "billed to you twice" names dollars the total
  // beside it still carries. A dropped copy adds its own usage here; a raise
  // taken by the surviving copy subtracts, because the raise is added straight
  // back to the corpus. Keyed by model, speed and UTC day exactly as `byModel`
  // is, so each side is priced at the rate that applied to it rather than at a
  // corpus average, and a raise nets against the copy it came from.
  const addRemoved = (
    model: string,
    speed: 'standard' | 'fast',
    at: number | null,
    usage: RawUsage,
    turns: number,
  ): void => {
    const key = modelRowKey(model, speed, at);
    const row = removedRows.get(key);
    if (row === undefined) {
      removedRows.set(key, { model, speed, usage: { ...usage }, turns, at });
      return;
    }
    row.usage = addUsage(row.usage, usage);
    row.turns += turns;
    if (at !== null && (row.at == null || at < row.at)) row.at = at;
  };

  for (const group of holders.values()) {
    if (group.length < 2) continue;
    let owner = group[0];
    if (owner === undefined) continue;
    let billed = owner.msg.usage;
    for (const candidate of group.slice(1)) {
      billed = maxUsage(billed, candidate.msg.usage);
      if (outranks(candidate.stat, owner.stat)) owner = candidate;
    }
    messagesMerged += 1;

    // The same law the per-file rewrite collapse uses: a message is worth the
    // maximum per field of every line that restated it, wherever those lines
    // ended up. A copy that caught one rewrite the original did not is still the
    // same request, and the higher figure is the one that was billed.
    const ownerUsage = owner.msg.usage;
    if (
      billed.input !== ownerUsage.input ||
      billed.cacheWrite !== ownerUsage.cacheWrite ||
      billed.cacheRead !== ownerUsage.cacheRead ||
      billed.output !== ownerUsage.output
    ) {
      let perStat = raises.get(owner.stat);
      if (perStat === undefined) {
        perStat = new Map<string, RawUsage>();
        raises.set(owner.stat, perStat);
      }
      perStat.set(crossFileKey(owner.msg), billed);

      // The raise never leaves the corpus, so it is not part of what the merge
      // removed. Subtracted at the OWNER's row — the row it is about to be
      // added to below — and carrying no turn, because a raise moves tokens
      // rather than requests. Skipped when the owner named no model, which is
      // the one case `applyToRow` also skips: with no row to raise there is
      // nothing added back and nothing to net off.
      if (owner.msg.model !== null) {
        addRemoved(
          owner.msg.model,
          owner.msg.speed,
          owner.msg.at,
          negate({
            input: billed.input - ownerUsage.input,
            cacheWrite: billed.cacheWrite - ownerUsage.cacheWrite,
            cacheRead: billed.cacheRead - ownerUsage.cacheRead,
            output: billed.output - ownerUsage.output,
          }),
          0,
        );
      }
    }

    for (const holder of group) {
      if (holder === owner) continue;
      copiesMerged += 1;
      const dropped = drops.get(holder.stat);
      if (dropped === undefined) drops.set(holder.stat, [holder.msg]);
      else dropped.push(holder.msg);

      if (holder.msg.model === null) continue;
      addRemoved(holder.msg.model, holder.msg.speed, holder.msg.at, holder.msg.usage, 1);
    }
  }

  const removed = [...removedRows.values()];
  if (drops.size === 0 && raises.size === 0) {
    return { stats: [...stats], messagesMerged, copiesMerged, transcriptsCorrected: 0, removed };
  }

  const corrected = stats.map((stat) => {
    const dropped = drops.get(stat);
    const raised = raises.get(stat);
    if (dropped === undefined && raised === undefined) return stat;

    // A new object every time. `scanAll` hands the same stats to more than one
    // caller and the tests aggregate the same array twice; a pass that edited
    // them in place would make the second read of a corpus differ from the first.
    const rows = new Map<string, ModelUsage>();
    for (const entry of stat.byModel) {
      // `at` is optional on a row a caller built by hand, and an absent one
      // means the same as a null one: no clock, so the empty day key. Mapping it
      // here keeps a hand-built row and a parsed one landing in the same bucket.
      rows.set(modelRowKey(entry.model, entry.speed, entry.at ?? null), {
        ...entry,
        usage: { ...entry.usage },
      });
    }

    let usage = { ...stat.usage };
    let turns = stat.turns;
    const droppedKeys = new Set((dropped ?? []).map(crossFileKey));
    const droppedIds = new Set((dropped ?? []).map((m) => m.id));

    const applyToRow = (msg: BilledMessage, delta: RawUsage, turnDelta: number): void => {
      if (msg.model === null) return;
      const row = rows.get(modelRowKey(msg.model, msg.speed, msg.at));
      if (row === undefined) return;
      row.usage = addUsage(row.usage, delta);
      row.turns += turnDelta;
      // `at` is left alone even when the message that set it has just gone.
      // Every record in a row shares a UTC day and rate periods start on a day
      // boundary, so the row still prices at the rate it always did.
    };

    for (const msg of dropped ?? []) {
      usage = addUsage(usage, negate(msg.usage));
      turns -= 1;
      applyToRow(msg, negate(msg.usage), -1);
    }

    const kept: BilledMessage[] = [];
    for (const msg of stat.billedMessages ?? []) {
      if (droppedKeys.has(crossFileKey(msg))) continue;
      const raise = raised?.get(crossFileKey(msg));
      if (raise === undefined) {
        kept.push(msg);
        continue;
      }
      const delta: RawUsage = {
        input: raise.input - msg.usage.input,
        cacheWrite: raise.cacheWrite - msg.usage.cacheWrite,
        cacheRead: raise.cacheRead - msg.usage.cacheRead,
        output: raise.output - msg.usage.output,
      };
      usage = addUsage(usage, delta);
      applyToRow(msg, delta, 0);
      kept.push({ ...msg, usage: { ...raise } });
    }

    return {
      ...stat,
      usage,
      turns,
      // A row that lost its last message is dropped rather than left at zero: a
      // zero-turn model row would still name a model in `byModel` and in the
      // dominant-rate vote that prices the startup prefix.
      byModel: [...rows.values()].filter((row) => row.turns > 0),
      messageIds: stat.messageIds.filter((id) => !droppedIds.has(id)),
      billedMessages: kept,
    };
  });

  return {
    stats: corrected,
    messagesMerged,
    copiesMerged,
    transcriptsCorrected: drops.size,
    removed,
  };
}

/**
 * Count what deduplication removed, and what it deliberately left behind.
 *
 * Three separate corrections land here and they are reported separately on
 * purpose, because a reader sizing the error needs to know which is which:
 *
 *  - Streamed rewrites, collapsed per transcript by `parse.ts`.
 *  - Copies of one billed message held by several transcripts and PROVED to be
 *    copies by a shared line uuid. `mergeResumedCopies` removed those, and
 *    `crossFileUsdMerged` prices them exactly — the removed copies are known per
 *    message, so unlike `duplicatedUsd` this is not an estimate. "Exactly" is
 *    load-bearing and is what `merge.removed` being a NET delta buys: corpus
 *    before minus corpus after is this figure, so the dollars named as removed
 *    are the dollars the total beside them no longer carries.
 *  - Ids still held by more than one transcript after that merge. Nothing proved
 *    those are the same request, so they were left counted twice and are stated
 *    rather than hidden.
 *
 * `stats` must be the CORRECTED corpus. Passing the pre-merge stats would count
 * every merged copy in the residual as well, reporting the same double-count in
 * both columns and claiming an error that was already removed.
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
  merge: CrossFileMerge,
  crossFileUsdMerged: number,
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
    crossFileMessagesMerged: merge.messagesMerged,
    crossFileCopiesMerged: merge.copiesMerged,
    crossFileTranscriptsCorrected: merge.transcriptsCorrected,
    crossFileUsdMerged,
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
 * Rows arrive already split per month. A session that crossed a boundary was
 * apportioned in `aggregate` by the UTC day each of its model rows carries, so
 * nothing here has to decide which month a session belongs to — `sessions` is
 * the only field a caller must not divide, and it arrives counted once.
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
  rows: readonly { month: string; usd: number; turns: number; sessions: number }[],
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

  // One row per month a session touched, not one row per session: `aggregate`
  // has already split a session that crossed a boundary, and it is the only
  // place that holds both a session's per-day model rows and its dollars.
  for (const row of rows) {
    const acc = blank(row.month);
    acc.usd += row.usd;
    acc.turns += row.turns;
    acc.sessions += row.sessions;
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

export function aggregate(rawStats: readonly SessionStat[], opts: AggregateOptions): Report {
  const { table, ttl, cacheWriteMult } = opts;
  const topN = opts.topN ?? 20;

  // Count each billed message once across the whole corpus BEFORE anything is
  // priced, so every figure below — totals, per-model rows, per-project rows,
  // the session table, the monthly series and the plan comparison — is built
  // from the corrected numbers rather than corrected afterwards in one place and
  // left wrong in the others. Both the CLI and the browser enter here, which is
  // what keeps the two surfaces agreeing about one directory.
  const merge = mergeResumedCopies(rawStats);
  const stats = merge.stats;
  // Priced as themselves, at each removed copy's own model, speed and rate
  // period — not at a corpus average. `merge.removed` is bucketed exactly the
  // way `byModel` is, so this is the same arithmetic the totals get.
  const crossFileUsdMerged = priceAll(merge.removed, table, ttl).cost.total;

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
  const dated: { month: string; usd: number; turns: number; sessions: number }[] = [];
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

    // A session is apportioned across calendar months by the timestamps its own
    // model rows carry, not booked whole to the month it opened in.
    //
    // `parse.ts` and `codex-parse.ts` both bucket `byModel` per model, per
    // speed, per UTC day, and a UTC day never straddles a month boundary — so a
    // session running across midnight on the last of the month arrives here as
    // separate rows on either side of it and the split is exact rather than
    // apportioned by a rule. Pricing each group and summing is the same
    // arithmetic as pricing the whole: `priceAll` prices row by row, so
    // partitioning the rows cannot move the corpus total.
    //
    // It used to be booked whole to the start month, justified by a comment
    // saying the split "would need per-turn timestamps this aggregator does not
    // carry". That was true before `ModelUsage.at` existed and false after.
    // The bias it left was one-directional and unbounded: a session opening a
    // minute before a month ends carried however much it went on to cost back
    // across the boundary, and because `planUtilization` takes its multiple over
    // COMPLETE months only, value dragged out of a partial month landed in a
    // numerator that month is excluded from — inflating the one figure this
    // feature promises never to overstate.
    //
    // Two things deliberately do NOT divide. A row with no timestamp falls back
    // to the month the session opened in, because a neighbouring row's clock is
    // not evidence of when it ran — the same rule `cost.ts` applies when it
    // prices such a row. And the SESSION count goes whole to the start month:
    // turns and dollars are quantities, a session is not, and splitting the
    // count would report one session as two.
    if (stat.startedAt !== null) {
      const startMonth = monthKey(stat.startedAt);
      const rowsByMonth = new Map<string, ModelUsage[]>();
      let rowTurns = 0;
      for (const entry of stat.byModel) {
        const month = entry.at == null ? startMonth : monthKey(entry.at);
        const group = rowsByMonth.get(month);
        if (group === undefined) rowsByMonth.set(month, [entry]);
        else group.push(entry);
        rowTurns += entry.turns;
      }

      // A billed message whose transcript never named a model produces no
      // `byModel` row, so the rows can carry fewer turns than the session did.
      // Those turns are real and go to the start month rather than being
      // dropped: `turns` is what `usdPerTurn` and the length buckets read.
      const orphanTurns = stat.turns - rowTurns;

      for (const month of new Set([startMonth, ...rowsByMonth.keys()])) {
        const group = rowsByMonth.get(month) ?? [];
        dated.push({
          month,
          usd: group.length > 0 ? priceAll(group, table, ttl).cost.total : 0,
          turns:
            group.reduce((n, row) => n + row.turns, 0) + (month === startMonth ? orphanTurns : 0),
          sessions: month === startMonth && !stat.isSubagent ? 1 : 0,
        });
      }
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
    ...(table.datedByProvider === undefined
      ? {}
      : {
          priceTableDatedByProvider: Object.fromEntries(
            Object.entries(table.datedByProvider).map(([vendor, v]) => [vendor, v.dated]),
          ),
        }),
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
    deduplication: deduplicationStats(stats, usdPerTurn, merge, crossFileUsdMerged),
    byMonth: monthlyCosts(dated, earliest, latest),
    undatedUsd,
  };
}

/** Straight-line monthly projection from the corpus span. */
export function monthlyProjection(report: Report): number {
  return (report.cost.total / report.spanDays) * 30;
}

export type { CostBreakdown };
