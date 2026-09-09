import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregate, mergeResumedCopies } from '../aggregate.js';
import { cacheWriteMultiplier, priceAll } from '../cost.js';
import { parseTranscript } from '../parse.js';
import { renderReport } from '../report.js';
import { scanAll } from '../scan.js';
import type { PriceTable, SessionStat } from '../types.js';

/**
 * Cross-file deduplication, and the two shapes it has to tell apart.
 *
 * Measured on a real 2,252-transcript corpus on 2026-09-07: 1,397 `message.id`
 * values appear in more than one transcript, across 51 files. Two different
 * mechanisms produce that, and merging both — or neither — is wrong in opposite
 * directions.
 *
 *  1. A RESUMED session copies its parent's transcript lines forward verbatim.
 *     `sessionId` is rewritten to the new session on every copied line, so it
 *     cannot separate them, but the per-line `uuid` is carried over unchanged:
 *     1,394 of the 1,397 shared ids have a byte-identical first `uuid` in every
 *     holder and 1,386 have identical uuid SETS. Those copies were billed once
 *     and have to be counted once.
 *
 *  2. The same id turning up in transcripts whose uuid sets are DISJOINT. Three
 *     ids on that corpus, all of them streaming rewrites of one subagent's
 *     message that the writer scattered across sibling subagent files. The same
 *     shape is what an API gateway produces when two genuinely independent
 *     sessions are handed the same id — and there, merging UNDER-counts real
 *     spend. Without evidence that two records are the same billed message they
 *     are left alone and reported as a residual.
 *
 * So the rule is: merge across files only when `message.id` AND the first `uuid`
 * written for that message both match. A uuid is minted per line by whoever
 * wrote the line, so sharing one is proof of a copy; not sharing one is not
 * proof of anything, which is why the residual is disclosed rather than merged.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;

const CROSSFILE = path.join(root, 'fixtures', 'crossfile');
const PROJECTS = path.join(root, 'fixtures', 'projects');

const opts = { table, ttl: '5m' as const, cacheWriteMult: cacheWriteMultiplier(table, '5m') };

function corpus(): SessionStat[] {
  return scanAll(CROSSFILE);
}

function byId(stats: readonly SessionStat[], id: string): SessionStat {
  const found = stats.find((s) => s.id === id);
  if (!found) throw new Error(`fixture ${id} not scanned`);
  return found;
}

describe('what parse.ts hands the corpus pass', () => {
  it('records the first uuid written for each billed message', () => {
    const a = byId(corpus(), 'chain-a');
    expect(a.billedMessages?.map((m) => [m.id, m.uuid])).toEqual([
      ['msg_a1', 'u-a1'],
      ['msg_a2', 'u-a2'],
    ]);
  });

  it('carries the collapsed usage, not one rewrite of it', () => {
    // msg_a1 is written twice. The second line has its own uuid and its own
    // partial usage; the message the corpus pass moves around is the collapsed
    // one, so a merge can never resurrect a rewrite that was already discarded.
    const a = byId(corpus(), 'chain-a');
    expect(a.billedMessages?.[0]?.usage).toEqual({
      input: 10,
      cacheWrite: 100,
      cacheRead: 0,
      output: 40,
    });
  });

  it('leaves a record with an id but no uuid out of the cross-file index', () => {
    // Nothing to prove a copy with, so it stays where it is and is counted.
    // This is the direction the whole correction leans: under-correct rather
    // than merge two records that might be two different requests.
    const line = JSON.stringify({
      message: {
        id: 'msg_no_uuid',
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const stat = parseTranscript(`${line}\n`, {
      id: 's',
      project: 'p',
      isSubagent: false,
      bytes: 0,
    });
    expect(stat.turns).toBe(1);
    expect(stat.messageIds).toEqual(['msg_no_uuid']);
    expect(stat.billedMessages).toEqual([]);
  });
});

describe('a resume chain three deep', () => {
  it('counts each billed message once across the whole chain', () => {
    // chain-a wrote msg_a1 and msg_a2. chain-b resumed it, copied both, then
    // wrote msg_b1. chain-c resumed chain-b, copied all three, then wrote
    // msg_c1. Nine records on disk, four API requests.
    const before = corpus();
    expect(before.reduce((n, s) => n + s.turns, 0)).toBe(15);

    const { stats } = mergeResumedCopies(before);
    const chain = stats.filter((s) => s.project === 'resume-chain');
    expect(chain.reduce((n, s) => n + s.turns, 0)).toBe(4);
  });

  it('attributes each message to one holder and strips it from the others', () => {
    const { stats } = mergeResumedCopies(corpus());
    expect(byId(stats, 'chain-a').turns).toBe(2);
    expect(byId(stats, 'chain-b').turns).toBe(1);
    expect(byId(stats, 'chain-c').turns).toBe(1);

    expect(byId(stats, 'chain-b').usage).toEqual({
      input: 6,
      cacheWrite: 0,
      cacheRead: 300,
      output: 30,
    });
    expect(byId(stats, 'chain-c').usage).toEqual({
      input: 8,
      cacheWrite: 0,
      cacheRead: 400,
      output: 15,
    });
  });

  it('keeps the per-model rows in step with the corrected totals', () => {
    const { stats } = mergeResumedCopies(corpus());
    const b = byId(stats, 'chain-b');
    expect(b.byModel).toHaveLength(1);
    expect(b.byModel[0]?.turns).toBe(1);
    expect(b.byModel[0]?.usage).toEqual(b.usage);
  });

  it('does not touch the startup prefix a resumed session reports', () => {
    // The copied first message is the honest witness of the fixed context that
    // every turn of that session re-reads. Re-deriving the prefix from the first
    // message the session wrote ITSELF would read a mid-conversation cache read
    // as startup context and inflate the figure by the whole parent transcript.
    const before = byId(corpus(), 'chain-c').startupPrefix;
    const { stats } = mergeResumedCopies(corpus());
    expect(byId(stats, 'chain-c').startupPrefix).toBe(before);
    expect(before).toBe(110);
  });
});

describe('a compaction is not a copy', () => {
  it('gives the compaction summary line no turn and no message id', () => {
    const c = byId(corpus(), 'compacted');
    expect(c.turns).toBe(2);
    expect(c.messageIds).toEqual(['msg_p1', 'msg_p2']);
  });

  it('still merges the post-compaction message a later session copied', () => {
    const { stats } = mergeResumedCopies(corpus());
    expect(byId(stats, 'compacted').turns).toBe(2);
    expect(byId(stats, 'after-compact').turns).toBe(1);
    expect(byId(stats, 'after-compact').usage).toEqual({
      input: 1,
      cacheWrite: 0,
      cacheRead: 180,
      output: 11,
    });
  });
});

describe('two independent sessions that share an id are left alone', () => {
  it('merges neither copy', () => {
    const { stats } = mergeResumedCopies(corpus());
    expect(byId(stats, 'gateway-one').turns).toBe(1);
    expect(byId(stats, 'gateway-two').turns).toBe(1);
    expect(byId(stats, 'gateway-one').usage.input).toBe(5);
    expect(byId(stats, 'gateway-two').usage.input).toBe(7);
  });

  it('still reports the overlap it refused to merge', () => {
    const r = aggregate(corpus(), opts);
    expect(r.deduplication.sharedMessageIds).toBe(1);
    expect(r.deduplication.transcriptsSharingHistory).toBe(2);
    expect(r.deduplication.duplicatedTurns).toBe(1);
    expect(r.deduplication.duplicatedUsd).toBeGreaterThan(0);
  });
});

describe('the corrected corpus', () => {
  it('reports the tokens that were actually billed', () => {
    const r = aggregate(corpus(), opts);
    expect(r.turns).toBe(9);
    expect(r.usage).toEqual({ input: 46, cacheWrite: 150, cacheRead: 1450, output: 157 });
  });

  it('names how much it removed, and prices that exactly', () => {
    const r = aggregate(corpus(), opts);
    expect(r.deduplication.crossFileMessagesMerged).toBe(4);
    expect(r.deduplication.crossFileCopiesMerged).toBe(6);
    expect(r.deduplication.crossFileTranscriptsCorrected).toBe(3);

    // Unlike `duplicatedUsd`, this is not an estimate: the copies that were
    // removed are known per message, so they can be priced as themselves.
    //
    // Split by UTC day rather than summed into one row, because that is how the
    // merge buckets them and a rate period can begin on any day boundary. One
    // combined row happens to price the same today — no rate moves between these
    // two dates — but it would stop doing so the moment one did, and the test
    // would then fail for a reason that has nothing to do with deduplication.
    // 2026-09-01: msg_a1 x2, msg_a2 x2, msg_b1 x1. 2026-09-02: msg_p2 x1.
    const removed = priceAll(
      [
        {
          model: 'claude-opus-5',
          speed: 'standard' as const,
          usage: { input: 34, cacheWrite: 200, cacheRead: 700, output: 150 },
          turns: 5,
          at: Date.parse('2026-09-01T10:00:00.000Z'),
        },
        {
          model: 'claude-opus-5',
          speed: 'standard' as const,
          usage: { input: 2, cacheWrite: 0, cacheRead: 150, output: 9 },
          turns: 1,
          at: Date.parse('2026-09-02T09:06:00.000Z'),
        },
      ],
      table,
      '5m',
    );
    expect(r.deduplication.crossFileUsdMerged).toBeCloseTo(removed.cost.total, 12);
    expect(r.deduplication.crossFileUsdMerged).toBeGreaterThan(0);
  });

  it('leaves every corrected transcript internally consistent', () => {
    // `mergeResumedCopies` subtracts a removed copy from `usage` and from the
    // `byModel` row it was summed into, in two separate steps keyed by a string
    // it rebuilds from the message. If those keys ever stop agreeing, the row
    // lookup misses, `usage` drops and `byModel` does not — and every total
    // still looks plausible while the model table quietly stops summing to it.
    // Nothing else in the suite would notice.
    const { stats } = mergeResumedCopies(corpus());
    for (const stat of stats) {
      const summed = stat.byModel.reduce(
        (acc, row) => ({
          input: acc.input + row.usage.input,
          cacheWrite: acc.cacheWrite + row.usage.cacheWrite,
          cacheRead: acc.cacheRead + row.usage.cacheRead,
          output: acc.output + row.usage.output,
        }),
        { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      );
      expect({ id: stat.id, ...summed }).toEqual({ id: stat.id, ...stat.usage });
      expect(stat.byModel.reduce((n, row) => n + row.turns, 0)).toBe(stat.turns);
      expect(stat.turns).toBeGreaterThanOrEqual(0);
      expect(stat.usage.input).toBeGreaterThanOrEqual(0);
      expect(stat.usage.cacheRead).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves the transcript and session counts alone', () => {
    // Seven files were read and seven sessions ran. Removing a copied message
    // does not remove the session that copied it.
    const r = aggregate(corpus(), opts);
    expect(r.transcriptCount).toBe(7);
    expect(r.sessionCount).toBe(7);
  });
});

describe('the pass is pure and order-independent', () => {
  it('does not mutate the stats it was given', () => {
    const stats = corpus();
    const beforeTurns = stats.map((s) => s.turns);
    const beforeUsage = stats.map((s) => ({ ...s.usage }));
    mergeResumedCopies(stats);
    expect(stats.map((s) => s.turns)).toEqual(beforeTurns);
    expect(stats.map((s) => ({ ...s.usage }))).toEqual(beforeUsage);
  });

  it('picks the same owner whatever order the transcripts arrive in', () => {
    const forward = mergeResumedCopies(corpus()).stats;
    const reversed = mergeResumedCopies([...corpus()].reverse()).stats;
    for (const id of ['chain-a', 'chain-b', 'chain-c', 'compacted', 'after-compact']) {
      expect(byId(reversed, id).turns).toBe(byId(forward, id).turns);
      expect(byId(reversed, id).usage).toEqual(byId(forward, id).usage);
    }
  });

  it('is idempotent', () => {
    const once = mergeResumedCopies(corpus());
    const twice = mergeResumedCopies(once.stats);
    expect(twice.copiesMerged).toBe(0);
    expect(twice.stats.map((s) => s.turns)).toEqual(once.stats.map((s) => s.turns));
  });
});

describe('a corpus with no message ids is untouched', () => {
  it('leaves the pricing-anchor fixtures exactly as they were', () => {
    const anchor = scanAll(PROJECTS);
    const { stats, copiesMerged } = mergeResumedCopies(anchor);
    expect(copiesMerged).toBe(0);
    expect(stats).toEqual(anchor);
    expect(aggregate(anchor, opts).deduplication.crossFileUsdMerged).toBe(0);
  });
});

describe('the report states the merge and the residual separately', () => {
  it('says what was merged and what was not', () => {
    const html = renderReport(aggregate(corpus(), opts));
    expect(html).toContain('Resumed history is counted once');
    expect(html).toContain('more than one transcript');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
  });

  it('says nothing about a merge when nothing was merged', () => {
    const html = renderReport(aggregate(scanAll(PROJECTS), opts));
    expect(html).not.toContain('Resumed history is counted once');
  });
});

/**
 * A copy that caught a rewrite the original did not.
 *
 * `mergeResumedCopies` values a merged message at the maximum per field of every
 * holder, so when a DROPPED copy carries that maximum the owner's own row is
 * raised to it. The corpus then loses less than the dropped copies were worth:
 * the raise is added straight back. Pricing the dropped copies alone therefore
 * overstates what the merge actually removed, in a figure the report prints as
 * "billed to you twice" and calls exact.
 *
 * Both holders are built by hand rather than as fixtures. The point of the case
 * is the arithmetic, and a fixture would have to be added to `fixtures/crossfile`
 * where it would move every count the rest of this file pins.
 */
function raiseCorpus(): SessionStat[] {
  const at = Date.parse('2026-09-01T10:00:00.000Z');
  const stat = (
    id: string,
    startedAt: number,
    usage: { input: number; cacheWrite: number; cacheRead: number; output: number },
  ): SessionStat => ({
    file: `${id}.jsonl`,
    project: 'raise',
    id,
    turns: 1,
    usage,
    byModel: [{ model: 'claude-opus-5', speed: 'standard', usage, turns: 1, at }],
    startupPrefix: 0,
    isSubagent: false,
    toolBytes: {},
    connectorBytes: {},
    connectorCalls: {},
    producedFile: false,
    fileWrites: 0,
    startedAt,
    endedAt: at,
    bytes: 4096,
    usageRewrites: 0,
    unidentifiedUsage: 0,
    messageIds: ['msg_r1'],
    billedMessages: [
      { id: 'msg_r1', uuid: 'u-r1', usage, model: 'claude-opus-5', speed: 'standard', at },
    ],
  });

  // Same message, same line id, so this is a proved copy. The parent starts
  // first and therefore KEEPS the message; the copy the merge drops is the one
  // that caught the later rewrite, at 400 output tokens against the owner's 100.
  return [
    stat('parent', at - 3_600_000, { input: 10, cacheWrite: 0, cacheRead: 1000, output: 100 }),
    stat('child', at + 3_600_000, { input: 10, cacheWrite: 0, cacheRead: 1000, output: 400 }),
  ];
}

/** Every model row in a corpus, priced as one list. */
function priceCorpus(stats: readonly SessionStat[]): number {
  return priceAll(
    stats.flatMap((s) => s.byModel),
    table,
    '5m',
  ).cost.total;
}

describe('what the merge says it removed is what it removed', () => {
  it('does not price a dropped copy above what the corpus actually lost', () => {
    // The invariant, stated as arithmetic: corpus before minus corpus after IS
    // the merged figure. Anything else and the "billed to you twice" line in the
    // report names a number that was never removed from the total beside it.
    const before = raiseCorpus();
    const { stats: after } = mergeResumedCopies(before);
    const removed = priceCorpus(before) - priceCorpus(after);

    const r = aggregate(before, opts);
    expect(r.deduplication.crossFileUsdMerged).toBeCloseTo(removed, 12);
  });

  it('never reports more removed than the corpus lost, on the fixture corpus either', () => {
    // The fixture corpus has no raise in it today, so this passes either way —
    // it is here so that adding one cannot quietly reintroduce the overstatement.
    const before = corpus();
    const { stats: after } = mergeResumedCopies(before);
    const r = aggregate(before, opts);
    expect(r.deduplication.crossFileUsdMerged).toBeCloseTo(
      priceCorpus(before) - priceCorpus(after),
      12,
    );
  });

  it('still keeps the raise itself, so the corpus total is the billed one', () => {
    // The correction below must come out of the REPORTED figure, not out of the
    // merge: the raised message really was billed at 400 output tokens, and
    // dropping the raise to make the arithmetic tidy would understate the bill.
    const { stats } = mergeResumedCopies(raiseCorpus());
    const kept = stats.filter((s) => s.turns > 0);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.usage.output).toBe(400);
  });
});
