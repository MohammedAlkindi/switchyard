import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregate } from '../aggregate.js';
import { cacheWriteMultiplier } from '../cost.js';
import { parseTranscript } from '../parse.js';
import { renderReport } from '../report.js';
import { scanAll } from '../scan.js';
import type { PriceTable, SessionStat } from '../types.js';

/**
 * Claude Code rewrites each streamed assistant message several times, and every
 * rewrite repeats that message's CUMULATIVE usage. Summing `message.usage` once
 * per line therefore multiplies the bill: measured 2026-09-03 on a real
 * 1,884-transcript corpus, 150,662 usage-bearing lines collapse to 65,474
 * messages, inflating input 3.44x, cache writes 2.83x, cache reads 2.23x,
 * output 2.16x and the priced total 2.43x.
 *
 * `fixtures/dedup/` is the hand-built shape of that bug. It is deliberately a
 * SEPARATE corpus from `fixtures/projects/`: the pricing anchor in
 * `pipeline.test.ts` is a regression detector for the pricing path, and folding
 * duplicate ids into the corpus it measures would force that anchor to move for
 * a reason that has nothing to do with rates.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;

const DEDUP = path.join(root, 'fixtures', 'dedup');
const PROJECTS = path.join(root, 'fixtures', 'projects');

const stats = scanAll(DEDUP);
function byId(id: string): SessionStat {
  const found = stats.find((s) => s.id === id);
  if (!found) throw new Error(`fixture ${id} not scanned`);
  return found;
}

describe('rewrites of one message are collapsed, not summed', () => {
  const parent = byId('parent');

  it('counts unique messages as turns rather than rewrites', () => {
    // Six usage-bearing lines: three rewrites of msg_parent_1, one
    // msg_parent_2, and two records carrying no id at all.
    expect(parent.turns).toBe(4);
    expect(parent.usageRewrites).toBe(2);
  });

  it('takes the maximum per field, not the sum', () => {
    // msg_parent_1 max  10 /  200 /   0 /  90
    // msg_parent_2      4  /    0 / 200 /  20
    // no id x2          1+1/     0 / 400 /   6
    expect(parent.usage).toEqual({ input: 16, cacheWrite: 200, cacheRead: 600, output: 116 });
  });

  it('takes the maximum even when it is neither the first nor the last rewrite', () => {
    // msg_parent_1 writes output 5, then 90, then 40. Last-wins would report
    // 40 and first-wins 5; only a maximum reports the 90 that was billed.
    const opus = parent.byModel.find((m) => m.model === 'claude-opus-5');
    expect(opus?.usage.output).toBe(116);
    expect(parent.usage.output).toBe(116);
  });

  it('applies the same correction to the per-model rows', () => {
    expect(parent.byModel).toHaveLength(1);
    const opus = parent.byModel[0];
    expect(opus?.turns).toBe(4);
    expect(opus?.usage).toEqual(parent.usage);
  });

  it('derives the startup prefix from the collapsed first message', () => {
    // The first LINE of msg_parent_1 is a partial rewrite carrying only
    // 10 input tokens; the message actually loaded 200 cache-write tokens as
    // well. Reading the first line understates the fixed context by 200.
    expect(parent.startupPrefix).toBe(210);
  });
});

describe('a record with no message.id is never dropped', () => {
  it('counts two identical id-less records as two turns', () => {
    // Nothing distinguishes these two lines from each other. Any dedup keyed on
    // the usage values, or bucketing every id-less record together, silently
    // halves real spend.
    const line = JSON.stringify({
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 200,
          output_tokens: 3,
        },
      },
    });
    const stat = parseTranscript(`${line}\n${line}\n`, {
      id: 'anon',
      project: 'p',
      isSubagent: false,
      bytes: 0,
    });

    expect(stat.turns).toBe(2);
    expect(stat.unidentifiedUsage).toBe(2);
    expect(stat.usage).toEqual({ input: 2, cacheWrite: 0, cacheRead: 400, output: 6 });
  });

  it('treats an empty or non-string id as absent rather than as a key', () => {
    const withEmptyId = JSON.stringify({
      message: {
        id: '',
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const stat = parseTranscript(`${withEmptyId}\n${withEmptyId}\n`, {
      id: 'anon',
      project: 'p',
      isSubagent: false,
      bytes: 0,
    });

    expect(stat.turns).toBe(2);
    expect(stat.usage.output).toBe(2);
  });
});

describe('deduplication is scoped to one transcript', () => {
  it('still counts a message id that a resumed session copied from its parent', () => {
    // A resumed session copies its parent's history into a new file. Merging
    // across files would be a different correction with different evidence
    // behind it, so the id is counted in both places and the overlap is
    // reported instead.
    const resumed = byId('resumed');
    expect(resumed.turns).toBe(2);
    expect(resumed.usage).toEqual({ input: 10, cacheWrite: 0, cacheRead: 600, output: 29 });
    expect(resumed.messageIds).toEqual(['msg_parent_2', 'msg_child_1']);
  });

  it('reports how much history two transcripts share', () => {
    const report = aggregate(stats, {
      table,
      ttl: '5m',
      cacheWriteMult: cacheWriteMultiplier(table, '5m'),
    });

    expect(report.deduplication.rewritesCollapsed).toBe(2);
    expect(report.deduplication.unidentifiedRecords).toBe(2);
    expect(report.deduplication.sharedMessageIds).toBe(1); // msg_parent_2
    expect(report.deduplication.transcriptsSharingHistory).toBe(2);
  });
});

describe('the deduplicated corpus prices to a hand-checkable total', () => {
  it('charges the collapsed usage, not the rewrites', () => {
    const report = aggregate(stats, {
      table,
      ttl: '5m',
      cacheWriteMult: cacheWriteMultiplier(table, '5m'),
    });

    // Every record is claude-opus-5 at standard speed: $5/M in, $25/M out,
    // cache write 1.25x input, cache read 0.1x input.
    //   input       26 x 5           =   130 / 1e6 = $0.000130
    //   cacheWrite  200 x 5 x 1.25   =  1250 / 1e6 = $0.001250
    //   cacheRead   1200 x 5 x 0.1   =   600 / 1e6 = $0.000600
    //   output      145 x 25         =  3625 / 1e6 = $0.003625
    //                                        total = $0.005605
    //
    // Summing every line instead gives 46/400/1200/190 tokens and $0.008080 —
    // 1.44x too high on six lines. On a real corpus the factor is ~2.3x,
    // because cache reads dominate and rewrites are far more numerous.
    expect(report.turns).toBe(6);
    expect(report.usage).toEqual({ input: 26, cacheWrite: 200, cacheRead: 1200, output: 145 });
    expect(report.cost.total).toBeCloseTo(0.005605, 9);
  });
});

describe('the report states what was collapsed and what was not', () => {
  const opts = { table, ttl: '5m' as const, cacheWriteMult: cacheWriteMultiplier(table, '5m') };

  it('names both counts, so a corrected total is distinguishable from a wrong one', () => {
    const html = renderReport(aggregate(stats, opts));

    expect(html).toContain('Streamed rewrites are counted once');
    expect(html).toContain('more than one transcript');
    // Still self-contained: the note must not reintroduce a remote reference.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
  });

  it('says nothing when there was nothing to collapse', () => {
    const html = renderReport(aggregate(scanAll(PROJECTS), opts));
    expect(html).not.toContain('Streamed rewrites are counted once');
  });
});

describe('a corpus with no message ids is untouched by the correction', () => {
  it('leaves the pricing-anchor fixtures exactly as they were', () => {
    // This is what lets `pipeline.test.ts` keep asserting $0.017854 across this
    // change. If a message id is ever added to `fixtures/projects/`, this test
    // fails first and says why the anchor moved.
    const anchorStats = scanAll(PROJECTS);
    expect(anchorStats.every((s) => s.messageIds.length === 0)).toBe(true);
    expect(anchorStats.every((s) => s.usageRewrites === 0)).toBe(true);
    expect(anchorStats.reduce((n, s) => n + s.turns, 0)).toBe(7);
  });
});

/**
 * The residual double-count has to be stated in the unit it is a double-count of.
 *
 * The report used to print the number of message ids that appear in more than
 * one transcript and then say "that much of the total above is still counted
 * twice". A count of ids is not a share of dollars, and on this fixture the two
 * differ: 1 of 6 turns is 16.7% by count, and the money behind it is 14.9% of
 * the total. Whichever way that gap falls it is the reader who eats it, because
 * the whole purpose of the disclosure is to let them size the remaining error.
 */
describe('the residual cross-file double-count is stated in dollars', () => {
  const opts = { table, ttl: '5m' as const, cacheWriteMult: cacheWriteMultiplier(table, '5m') };
  const report = aggregate(stats, opts);

  it('counts the redundant copies, not the ids', () => {
    // msg_parent_2 appears in both transcripts, so one of its two copies is
    // redundant. `sharedMessageIds` counts the id once; this counts the copy.
    expect(report.deduplication.sharedMessageIds).toBe(1);
    expect(report.deduplication.duplicatedTurns).toBe(1);
  });

  it('prices them at the mean cost per turn of the transcripts holding them', () => {
    // By hand, at opus-5 rates ($5/M in, $25/M out, 1.25x write, 0.1x read):
    //   parent  $0.004530 over 4 turns = $0.00113250 per turn
    //   resumed $0.001075 over 2 turns = $0.00053750 per turn
    //   one redundant copy of a message held by both = mean = $0.00083500
    expect(report.deduplication.duplicatedUsd).toBeCloseTo(0.000835, 9);

    // And it is genuinely a different number from the count-based one it
    // replaced: 1/6 of the total would be $0.00093417.
    expect(report.deduplication.duplicatedUsd).not.toBeCloseTo(report.cost.total / 6, 6);
  });

  it('is zero when no transcript shares history with another', () => {
    const clean = aggregate(scanAll(PROJECTS), opts);
    expect(clean.deduplication.duplicatedTurns).toBe(0);
    expect(clean.deduplication.duplicatedUsd).toBe(0);
  });

  it('puts the dollar figure and its share in the report, not an id count', () => {
    const html = renderReport(report);

    // $0.000835 formats to $0.0008; 0.000835 / 0.005605 = 14.9% of the total.
    expect(html).toContain('$0.0008');
    expect(html).toContain('14.9%');
    // The old wording attached "counted twice" to a message count. Anything that
    // reads as a dollar share must not be a count of ids.
    expect(html).not.toMatch(/message\(s\) appear in more than one transcript<\/strong>[^.]*still counted twice/);
  });
});
