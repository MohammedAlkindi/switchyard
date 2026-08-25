import type { DeadRun, Findings, SessionCost, SessionStat, TurnBucket } from './types.js';

/**
 * Heuristics that turn a pile of session costs into things worth acting on.
 *
 * Every function here is a *hypothesis about* waste, not a measurement of it.
 * That distinction is load-bearing and is reflected in the wording the report
 * uses: loadline says "no file written", never "wasted". A long read-only
 * research session is legitimate work and must not be labelled otherwise on the
 * strength of a heuristic. The numbers are offered so a human can judge.
 */

/** Below this, a long session with no file written is unremarkable. */
export const LONG_SESSION_TURNS = 200;

/**
 * A transcript this small never got going. Calibrated against real dead
 * scheduled runs, whose logs land in the hundreds of bytes while a genuine run
 * produces kilobytes. Paired with a turn count so a short *successful* session
 * is not mistaken for a corpse.
 */
export const DEAD_RUN_BYTES = 4096;
export const DEAD_RUN_TURNS = 3;

export const TURN_BUCKETS: ReadonlyArray<{ label: string; max: number }> = [
  { label: '1-50', max: 50 },
  { label: '51-200', max: 200 },
  { label: '201-500', max: 500 },
  { label: '501-1000', max: 1000 },
  { label: '1000+', max: Infinity },
];

export function bucketFor(turns: number): string {
  for (const b of TURN_BUCKETS) {
    if (turns <= b.max) return b.label;
  }
  return '1000+';
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
 * fired at all — the task still reports success. File size is what separates
 * them, and it is the only signal available after the fact.
 */
export function deadRuns(stats: readonly SessionStat[]): DeadRun[] {
  return stats
    .filter((s) => !s.isSubagent && s.bytes < DEAD_RUN_BYTES && s.turns <= DEAD_RUN_TURNS)
    .map((s) => ({ id: s.id, project: s.project, turns: s.turns, bytes: s.bytes, startedAt: s.startedAt }))
    .sort((a, b) => a.bytes - b.bytes);
}

/** Median startup prefix across main sessions that recorded one. */
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
