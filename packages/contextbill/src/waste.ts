import type { DeadRun, Findings, SessionCost, SessionStat, TurnBucket } from './types.js';

/**
 * Heuristics that turn a pile of session costs into things worth acting on.
 *
 * Every function here is a *hypothesis about* waste, not a measurement of it.
 * That distinction is load-bearing and is reflected in the wording the report
 * uses: contextbill says "no file written", never "wasted". A long read-only
 * research session is legitimate work and must not be labelled otherwise on the
 * strength of a heuristic. The numbers are offered so a human can judge.
 *
 * ## Every threshold below was re-derived on 2026-09-07, and why
 *
 * `turns` counts BILLED MESSAGES. Until v0.3.0 it counted transcript lines,
 * which inflated it 2.32x because Claude Code rewrites each streamed message
 * several times. Every constant here was written against the inflated count.
 *
 * They were NOT rescaled by 2.32. A threshold recovered by dividing out an
 * artifact of the old bug is still derived from the bug. Each one was instead
 * given back its meaning and re-cut against the distribution that meaning talks
 * about, measured on a FROZEN copy of a 2,187-transcript / 1.297 GB
 * `~/.claude/projects` corpus: 566 main sessions and 1,621 subagents, $14,727
 * API-equivalent in total, of which $11,291 belongs to main sessions. Every
 * share below is against that $11,291, because `SessionCost` is main sessions
 * only. `waste-thresholds.test.ts` pins these figures as anchors.
 *
 * Two things a rescale would have got backwards:
 *
 *  - `DEAD_RUN_TURNS` is a `<=` filter, so removing the inflation made it
 *    LOOSER, not stricter. It goes down, not up.
 *  - `DEAD_RUN_BYTES` never depended on the turn count at all. It was
 *    calibrated against the wrong artifact and matched nothing whatsoever.
 */

/**
 * Below this, a long session with no file written is unremarkable.
 *
 * "Unremarkable" is meant literally, and is what this value is cut against.
 * P(no file written | turns >= N) over 566 main sessions: 59.2% at N=1, 24.1%
 * at 5, 18.2% at 10, 10.2% at 20, 9.1% at 25, 7.7% at 40, **6.7% at 50**, 6.6%
 * at 60, 6.2% at 75, 4.8% at 100, 4.2% at 200. The curve is steep below 50 and
 * flat above it: below the knee this finding reports ordinary behaviour, and
 * far above it it reports almost nothing.
 *
 * It was 200, which is 200 real requests now rather than the ~86 the figure
 * stood for when it was written. At 200 the finding surfaced 2 sessions worth
 * $165; at 50 it surfaces 11 worth $351 - 3.1% of main-session spend, every one
 * over $11, still inside the 15-row cap `buildFindings` applies. The clearest
 * thing 200 was missing: a 57-turn read-only session costing $29.27, the 4th
 * most expensive read-only session on the machine.
 *
 * Sessions at or above this length are 29.2% of main sessions and 93.5% of
 * main-session spend.
 * It is also a `TURN_BUCKETS` boundary, so the two findings in the report
 * cannot disagree about where "long" starts.
 */
export const LONG_SESSION_TURNS = 50;

/**
 * A transcript this small never got going.
 *
 * This was 4096, and it matched **zero** transcripts in a 2,187-file corpus, so
 * the finding below could never fire. The old comment says why without noticing:
 * it was "calibrated against real dead scheduled runs, whose logs land in the
 * hundreds of bytes". Those are the scheduler's `*.log` files.
 * `SessionStat.bytes` is the JSONL transcript, a different artifact - Claude
 * Code writes the injected session context into the first records, so a run that
 * dies on startup still leaves ~15 KB behind. The measured floor across 566 main
 * transcripts is 14,663 bytes, and the four zero-turn corpses sit at 14,663 /
 * 15,010 / 15,998 / 16,247, with a fifth at 27,885.
 *
 * 32 KiB is where that tail ends, and the pairing with `DEAD_RUN_TURNS` becomes
 * a cross-check rather than a second free knob: no main transcript carrying 3 or
 * more billed messages is smaller than 37,690 bytes, so this ceiling cannot
 * admit a session that did real work even with the turn filter removed.
 * Nineteen transcripts match, worth $2.03 in total; the report shows the 15
 * smallest, which is what the cap in `buildFindings` is for.
 *
 * Paired with a turn count so a short *successful* session is not mistaken for
 * a corpse.
 *
 * CLAUDE CODE TRANSCRIPTS ONLY, and `deadRuns` enforces that. Every byte quoted
 * above came from `~/.claude/projects`, and the floor has a cause specific to
 * that writer: Claude Code writes the injected session context into the first
 * records, so a run that dies on startup still leaves ~15 KB behind. A Codex
 * rollout is a different file written by a different program, and nothing here
 * has measured what a dead one weighs. The five rollouts under `~/.codex`
 * available when this was written are 1.2 MB to 21.0 MB and contain no corpse
 * at all, so they can neither calibrate a Codex floor nor test one - a
 * threshold cut on that would be an invention, not a measurement.
 *
 * Carrying the Claude figure across anyway is the exact error the 2026-09-07
 * retune existed to correct: a constant read against a population it was never
 * cut on. Better to report nothing for Codex than to report a guess, so
 * `deadRuns` skips those transcripts and says so. Un-skipping them needs a
 * measured Codex size distribution WITH dead runs in it, and a separate
 * constant - not this one reused.
 */
export const DEAD_RUN_BYTES = 32_768;

/**
 * At most this many billed requests, and nothing was accomplished.
 *
 * It was 3 against a count inflated 2.32x, which stood for roughly 1.3 real
 * requests. Because this is a `<=` filter, leaving it at 3 after the inflation
 * was removed would more than double what it admits - the opposite of what
 * happened to every `>=` threshold in this file, and the reason this one is the
 * only value here that moves down.
 *
 * 2 is also what the v0.3.0 correction needs in order to pay off: the dead run
 * whose two messages were each rewritten three times scored 6 turns and escaped
 * the old `<= 3`. Deduplicated it scores 2 and is caught here.
 *
 * Honest limit: on the calibration corpus 2 and 3 select the same 19
 * transcripts, because `DEAD_RUN_BYTES` already excludes every transcript with
 * 3 or more turns. That redundancy is the safety property, not the evidence -
 * the value is 2 because that is what "effectively did nothing" means once a
 * turn is a request again.
 */
export const DEAD_RUN_TURNS = 2;

/**
 * Length bands for the spend-concentration table.
 *
 * The old bands (50 / 200 / 500 / 1000) were cut for the inflated count and
 * collapsed once it was corrected: 403 / 115 / 36 / 11 / 1 sessions carrying
 * 6.7 / 29.1 / 36.8 / 24.0 / 3.4% of spend. Two thirds of the population sat in
 * the first row, and the top row held a **single** session, so its "share" was
 * that one session's bill. A histogram shaped like that answers no question.
 *
 * Measured against these bands on 2026-09-07: 302 / 101 / 89 / 56 / 18 sessions
 * (53.4 / 17.8 / 15.7 / 9.9 / 3.2%) carrying 0.9 / 5.8 / 19.0 / 33.9 / 40.5% of
 * main-session spend, with every row populated.
 *
 * The property these bands are cut for is that EVERY ROW IS POPULATED and none
 * of them is one session wide. That is what the old bands failed - two thirds of
 * the population in the first row and a single session in the last - and it is
 * what makes the shares comparable at all.
 *
 * It is NOT that the shares rise monotonically. That was a fact about the
 * calibration corpus on the day it was cut, not a property of the bands, and it
 * did not survive a day: re-measured on 2026-09-08 over 571 main sessions the
 * same bands read 309 / 106 / 86 / 54 / 16 sessions carrying
 * 1.3 / 7.3 / 18.6 / 37.4 / 35.4% of main-session spend - every band populated,
 * and the top two the other way round. Nothing is wrong; the top band is 16
 * sessions and is the one that moves. A ramp cannot be promised by a fixed set
 * of boundaries over a changing population, and reading it as a guarantee turns
 * an ordinary week into an apparent defect in the table.
 *
 * The first row still holds half the sessions. That is the finding, not a
 * defect: half of all sessions are ten requests or fewer and account for 0.9% of
 * the bill. Its label starts at 0 because 17 main transcripts recorded no billed
 * message at all, and the old "1-50" label counted them anyway.
 */
export const TURN_BUCKETS: ReadonlyArray<{ label: string; max: number }> = [
  { label: '0-10', max: 10 },
  { label: '11-50', max: 50 },
  { label: '51-150', max: 150 },
  { label: '151-400', max: 400 },
  { label: '400+', max: Infinity },
];

/** Label of the open-ended top band. Derived so it cannot go stale on a retune. */
const OVERFLOW_BUCKET = TURN_BUCKETS[TURN_BUCKETS.length - 1]?.label ?? '';

export function bucketFor(turns: number): string {
  for (const b of TURN_BUCKETS) {
    if (turns <= b.max) return b.label;
  }
  return OVERFLOW_BUCKET;
}

/**
 * Long sessions that never wrote a file, most expensive first.
 *
 * Subagents are excluded: they routinely read without writing by design, and
 * including them would bury the main-session signal under noise.
 */
export function noFileWritten(sessions: readonly SessionCost[]): SessionCost[] {
  return sessions
    .filter((s) => !s.producedFile && s.turns >= LONG_SESSION_TURNS)
    .sort((a, b) => b.usd - a.usd);
}

/** Spend concentration by session length. */
export function turnBuckets(sessions: readonly SessionCost[]): TurnBucket[] {
  const totals = new Map<string, { usd: number; sessions: number }>();
  for (const b of TURN_BUCKETS) totals.set(b.label, { usd: 0, sessions: 0 });

  let grand = 0;
  for (const s of sessions) {
    const entry = totals.get(bucketFor(s.turns));
    if (!entry) continue;
    entry.usd += s.usd;
    entry.sessions += 1;
    grand += s.usd;
  }

  return TURN_BUCKETS.map((b) => {
    const entry = totals.get(b.label) ?? { usd: 0, sessions: 0 };
    return {
      label: b.label,
      usd: entry.usd,
      share: grand > 0 ? (100 * entry.usd) / grand : 0,
      sessions: entry.sessions,
    };
  });
}

/**
 * Transcripts that started and effectively did nothing.
 *
 * A scheduled agent that exits before doing any work leaves a transcript that is
 * indistinguishable, from the scheduler's point of view, from one that never
 * fired at all - the task still reports success.
 *
 * Both filters are load-bearing and neither is decorative. Size alone would
 * catch a one-shot question that ran fine; a turn count alone would catch a
 * session whose single request carried an enormous paste. The sort is by size
 * ascending so the 15-row cap in `buildFindings` keeps the smallest - the
 * likeliest corpses - rather than an arbitrary slice.
 *
 * Claude Code transcripts only. Both thresholds were cut on `~/.claude/projects`
 * and `DEAD_RUN_BYTES` in particular has a cause specific to that writer, so a
 * Codex rollout is skipped rather than judged against a floor nobody measured
 * for it. See `DEAD_RUN_BYTES`. This is a stated blind spot, not coverage: a
 * dead Codex rollout is not reported here at all.
 */
export function deadRuns(stats: readonly SessionStat[]): DeadRun[] {
  return stats
    .filter(
      (s) =>
        (s.source ?? 'claude-code') === 'claude-code' &&
        !s.isSubagent &&
        s.bytes < DEAD_RUN_BYTES &&
        s.turns <= DEAD_RUN_TURNS,
    )
    .map((s) => ({ id: s.id, project: s.project, turns: s.turns, bytes: s.bytes, startedAt: s.startedAt }))
    .sort((a, b) => a.bytes - b.bytes);
}

/**
 * Median startup prefix across main sessions that recorded one.
 *
 * Deliberately left alone in the 2026-09-07 retune. It carries no turn-count
 * dependency - the prefix is read from the first message after its rewrites are
 * collapsed, in `parse.ts` - and the upper-median convention here is pinned by
 * the reference-script comparison in CLAUDE.md's verification bar, which
 * requires this figure to match exactly. Changing the convention would break
 * that check for no measured gain.
 */
export function medianStartupPrefix(stats: readonly SessionStat[]): number {
  const values = stats
    .filter((s) => !s.isSubagent && s.startupPrefix > 0)
    .map((s) => s.startupPrefix)
    .sort((a, b) => a - b);
  if (values.length === 0) return 0;
  return values[Math.floor(values.length / 2)] ?? 0;
}

export function buildFindings(
  stats: readonly SessionStat[],
  sessions: readonly SessionCost[],
  startupPrefixUsd: number,
): Findings {
  return {
    noFileWritten: noFileWritten(sessions).slice(0, 15),
    turnBuckets: turnBuckets(sessions),
    deadRuns: deadRuns(stats).slice(0, 15),
    medianStartupPrefix: medianStartupPrefix(stats),
    startupPrefixUsd,
  };
}
