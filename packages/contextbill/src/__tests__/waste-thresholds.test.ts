import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregate } from '../aggregate.js';
import { cacheWriteMultiplier } from '../cost.js';
import { renderReport } from '../report.js';
import type { PriceTable, Report, SessionCost, SessionStat, SourceSummary } from '../types.js';
import {
  DEAD_RUN_BYTES,
  DEAD_RUN_TURNS,
  LONG_SESSION_TURNS,
  TURN_BUCKETS,
  bucketFor,
  deadRuns,
  noFileWritten,
  turnBuckets,
} from '../waste.js';

/**
 * These are calibration anchors, in the same spirit as the pricing anchor in
 * `pipeline.test.ts`: they exist to FAIL when a threshold drifts away from the
 * meaning it was given, not to describe the current constants back to
 * themselves.
 *
 * Every figure quoted below was measured on 2026-09-07 against a FROZEN copy of
 * a 2,187-transcript / 1.297 GB `~/.claude/projects` corpus (566 main sessions,
 * 1,621 subagents, $11,291 API-equivalent). Re-measuring is the only honest way
 * to move one of them.
 */

function session(over: Partial<SessionCost>): SessionCost {
  return {
    id: 'x',
    project: 'p',
    turns: 10,
    usd: 1,
    usdPerTurn: 0.1,
    producedFile: true,
    startupPrefix: 0,
    startedAt: null,
    bytes: 10_000,
    ...over,
  };
}

function stat(over: Partial<SessionStat>): SessionStat {
  return {
    file: '/tmp/x.jsonl',
    project: 'p',
    id: 'x',
    turns: 10,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    byModel: [],
    startupPrefix: 0,
    isSubagent: false,
    toolBytes: {},
    connectorBytes: {},
    connectorCalls: {},
    producedFile: true,
    fileWrites: 1,
    startedAt: null,
    endedAt: null,
    bytes: 50_000,
    usageRewrites: 0,
    unidentifiedUsage: 0,
    messageIds: [],
    ...over,
  };
}

describe('DEAD_RUN_BYTES is sized for a transcript, not for a scheduler log', () => {
  it('exceeds the size of a transcript that merely started', () => {
    // The threshold was 4096, taken from dead scheduled-run LOG files, which land
    // in the 90-535 byte range. `SessionStat.bytes` is the JSONL transcript, a
    // different artifact: a Claude Code transcript records its injected context
    // on the first records, so a session that dies immediately still writes
    // ~15 KB. Measured floor across 566 main transcripts: 14,663 bytes. At 4096
    // this finding matched ZERO transcripts and could never fire.
    expect(DEAD_RUN_BYTES).toBeGreaterThan(16_384);
  });

  it('cannot admit a transcript that did real work', () => {
    // The paired filters are meant to cross-check each other rather than be two
    // independent knobs. Measured: no main transcript with >= 3 billed messages
    // is smaller than 37,690 bytes, so a ceiling below that cannot select one.
    expect(DEAD_RUN_BYTES).toBeLessThan(37_690);
  });

  it('flags a realistically sized startup corpse', () => {
    // The four zero-turn corpses in the corpus measured 14,663 / 15,010 /
    // 15,998 / 16,247 bytes, plus one at 27,885.
    const result = deadRuns([
      stat({ id: 'corpse-small', bytes: 15_010, turns: 0, producedFile: false, fileWrites: 0 }),
      stat({ id: 'corpse-large', bytes: 27_885, turns: 0, producedFile: false, fileWrites: 0 }),
    ]);
    expect(result.map((d) => d.id)).toEqual(['corpse-small', 'corpse-large']);
  });

  it('does not flag the smallest transcript that did three requests', () => {
    expect(deadRuns([stat({ bytes: 37_690, turns: 3 })])).toEqual([]);
  });
});

describe('DEAD_RUN_TURNS counts billed messages, so it went DOWN not up', () => {
  it('catches the two-message corpse that streaming rewrites used to hide', () => {
    // v0.3.0: a dead run whose 2 messages were each rewritten 3x scored 6 turns
    // and escaped a `<= 3` filter. Deduplicated it scores 2 and must be caught.
    expect(deadRuns([stat({ id: 'c', bytes: 20_000, turns: 2 })]).map((d) => d.id)).toEqual(['c']);
  });

  it('leaves a three-request session alone', () => {
    // `<=` thresholds got LOOSER when the 2.32x inflation was removed, not
    // stricter: the old `<= 3` was roughly `<= 1.3` real requests. Three billed
    // requests is work-shaped, whatever the transcript weighs.
    expect(DEAD_RUN_TURNS).toBeLessThan(3);
    expect(deadRuns([stat({ bytes: 20_000, turns: 3 })])).toEqual([]);
  });
});

describe('LONG_SESSION_TURNS is the point where writing nothing stops being normal', () => {
  it('sits where P(no file written | turns >= N) flattens', () => {
    // Measured over 566 main sessions: 59.2% at N=1, 24.1% at 5, 18.2% at 10,
    // 10.2% at 20, 9.1% at 25, 7.7% at 40, 6.7% at 50, 6.6% at 60, 6.2% at 75,
    // 4.8% at 100, 4.2% at 200. Steep below 50, flat above it. Below the knee
    // the finding reports normal behaviour; far above it the finding reports
    // almost nothing (2 sessions at 200).
    expect(LONG_SESSION_TURNS).toBeGreaterThanOrEqual(40);
    expect(LONG_SESSION_TURNS).toBeLessThanOrEqual(75);
  });

  it('keeps the expensive short-ish read-only sessions the old value missed', () => {
    // A real 57-turn session that wrote nothing and cost $29.27 — the 4th most
    // expensive read-only session in the corpus. At 200 it was invisible.
    const flagged = noFileWritten([session({ id: 'research', turns: 57, usd: 29.27, producedFile: false })]);
    expect(flagged.map((s) => s.id)).toEqual(['research']);
  });

  it('agrees with the histogram about where "long" starts', () => {
    // The no-file-written cut is a bucket boundary, so the two findings in the
    // report cannot disagree about what counts as a long session.
    expect(TURN_BUCKETS.map((b) => b.max)).toContain(LONG_SESSION_TURNS);
  });
});

describe('TURN_BUCKETS spreads a real corpus instead of piling it in one row', () => {
  it('is ascending, non-empty, and open-ended at the top', () => {
    const maxes = TURN_BUCKETS.map((b) => b.max);
    expect(maxes.length).toBeGreaterThanOrEqual(4);
    expect(maxes).toEqual([...maxes].sort((a, b) => a - b));
    expect(new Set(maxes).size).toBe(maxes.length);
    expect(maxes[maxes.length - 1]).toBe(Infinity);
  });

  it('puts a zero-turn transcript in a bucket whose label admits it', () => {
    // 17 of 566 main transcripts recorded no billed message at all. The old
    // first label read "1-50" and quietly counted them anyway.
    expect(bucketFor(0)).toMatch(/^0/);
  });

  it('spreads the measured corpus shape across every bucket', () => {
    // Session lengths measured on the frozen corpus, 566 sessions, reproducing
    // its bucket shape exactly (302 / 101 / 89 / 56 / 18). Under the old
    // boundaries the same corpus collapsed to 403 / 115 / 36 / 11 / 1: two
    // thirds of all sessions in one row, and a top row holding a single session
    // whose "share" was just that one session's bill.
    const measured: Array<[number, number]> = [
      [0, 17],
      [1, 260],
      [8, 25],
      [30, 101],
      [70, 60],
      [120, 29],
      [200, 36],
      [300, 20],
      [450, 11],
      [700, 6],
      [1100, 1],
    ];
    const corpus = measured.flatMap(([turns, n]) =>
      Array.from({ length: n }, () => session({ turns, usd: turns })),
    );
    expect(corpus).toHaveLength(566);
    const buckets = turnBuckets(corpus);
    expect(buckets.map((b) => b.sessions)).toEqual([302, 101, 89, 56, 18]);
    for (const b of buckets) {
      // No row may be a rounding error, and no row may swallow the corpus.
      expect(b.sessions).toBeGreaterThan(1);
      expect(b.sessions / corpus.length).toBeLessThan(0.6);
    }
  });
});

describe('the dead-run threshold is scoped to the population it was cut on', () => {
  it('does not apply a Claude-derived size floor to a Codex rollout', () => {
    // `DEAD_RUN_BYTES` is 32 KiB because Claude Code writes its injected session
    // context into the first records, so a run that dies on startup still leaves
    // ~15 KB behind — a floor with a cause specific to that writer. A Codex
    // rollout is a different file written by a different program and nothing
    // here has measured what a dead one weighs. Applying the figure across both
    // is the same mistake the 2026-09-07 retune existed to correct: a threshold
    // read against a population it was never cut on.
    const codex = stat({ id: 'cx', source: 'codex', bytes: 1_000, turns: 1 });
    expect(deadRuns([codex])).toEqual([]);
  });

  it('still catches a Claude transcript of the same shape', () => {
    // The scoping must be about the source and nothing else, or it has quietly
    // turned the finding off.
    const claude = stat({ id: 'cc', bytes: 1_000, turns: 1 });
    expect(deadRuns([claude]).map((d) => d.id)).toEqual(['cc']);
    expect(deadRuns([{ ...claude, source: 'claude-code' }]).map((d) => d.id)).toEqual(['cc']);
  });
});

describe('the report states the dead-run scope rather than implying coverage', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const table = JSON.parse(
    fs.readFileSync(path.join(root, 'prices.json'), 'utf8'),
  ) as PriceTable;

  const empty = (): Report =>
    aggregate([], { table, ttl: '5m', cacheWriteMult: cacheWriteMultiplier(table, '5m') });

  const summary = (source: SourceSummary['source'], label: string): SourceSummary => ({
    source,
    label,
    transcripts: 1,
    sessions: 1,
    turns: 1,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    usd: 0,
    unpricedModels: [],
    unpricedTurns: 0,
    fullyPriced: true,
  });

  it('names the limit when a rollout it cannot judge was read', () => {
    // An empty table means "nothing died" to a reader. It has to mean "nothing
    // died among the transcripts this check can read" once part of the corpus is
    // deliberately skipped, or the silence reads as coverage.
    const html = renderReport({
      ...empty(),
      bySource: [summary('claude-code', 'Claude Code'), summary('codex', 'Codex')],
    });
    expect(html).toContain('Claude Code transcripts only');
  });

  it('says nothing about a scope that cannot bite', () => {
    // On a Claude-only corpus the exclusion excludes nothing, and a caveat about
    // an absence that cannot arise is noise in a report already dense with them.
    expect(renderReport(empty())).not.toContain('Claude Code transcripts only');
  });
});
