import { describe, expect, it } from 'vitest';

import type { SessionCost, SessionStat } from '../types.js';
import { bucketFor, deadRuns, medianStartupPrefix, noFileWritten, turnBuckets } from '../waste.js';

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
    ...over,
  };
}

describe('bucketFor', () => {
  it('places turn counts on the right boundary', () => {
    expect(bucketFor(1)).toBe('1-50');
    expect(bucketFor(50)).toBe('1-50');
    expect(bucketFor(51)).toBe('51-200');
    expect(bucketFor(500)).toBe('201-500');
    expect(bucketFor(1000)).toBe('501-1000');
    expect(bucketFor(1001)).toBe('1000+');
  });
});

describe('noFileWritten', () => {
  it('flags only long sessions that wrote nothing, most expensive first', () => {
    const result = noFileWritten([
      session({ id: 'short-no-write', turns: 5, producedFile: false, usd: 99 }),
      session({ id: 'long-wrote', turns: 400, producedFile: true, usd: 50 }),
      session({ id: 'long-no-write-cheap', turns: 400, producedFile: false, usd: 2 }),
      session({ id: 'long-no-write-dear', turns: 900, producedFile: false, usd: 30 }),
    ]);
    expect(result.map((s) => s.id)).toEqual(['long-no-write-dear', 'long-no-write-cheap']);
  });

  it('does not flag a short session, however expensive', () => {
    // A 5-turn session that burned money is not a runaway loop; it is one
    // expensive question. Flagging it would bury the real signal.
    expect(noFileWritten([session({ turns: 5, producedFile: false, usd: 1000 })])).toEqual([]);
  });
});

describe('turnBuckets', () => {
  it('computes share of spend per bucket', () => {
    const buckets = turnBuckets([
      session({ turns: 10, usd: 25 }),
      session({ turns: 700, usd: 75 }),
    ]);
    const short = buckets.find((b) => b.label === '1-50');
    const long = buckets.find((b) => b.label === '501-1000');
    expect(short?.share).toBeCloseTo(25, 6);
    expect(long?.share).toBeCloseTo(75, 6);
    expect(long?.sessions).toBe(1);
  });

  it('returns zero shares rather than NaN on an empty corpus', () => {
    for (const b of turnBuckets([])) {
      expect(b.share).toBe(0);
      expect(b.usd).toBe(0);
    }
  });
});

describe('deadRuns', () => {
  it('flags tiny short transcripts', () => {
    const result = deadRuns([
      stat({ id: 'corpse', bytes: 300, turns: 1 }),
      stat({ id: 'healthy', bytes: 200_000, turns: 400 }),
    ]);
    expect(result.map((d) => d.id)).toEqual(['corpse']);
  });

  it('does not flag a small transcript that actually did work', () => {
    // Size alone is not the signal — a short but real session has turns.
    expect(deadRuns([stat({ bytes: 3000, turns: 40 })])).toEqual([]);
  });

  it('ignores subagents, which are legitimately small', () => {
    expect(deadRuns([stat({ bytes: 200, turns: 1, isSubagent: true })])).toEqual([]);
  });
});

describe('medianStartupPrefix', () => {
  it('takes the median of main sessions only', () => {
    const value = medianStartupPrefix([
      stat({ startupPrefix: 100 }),
      stat({ startupPrefix: 200 }),
      stat({ startupPrefix: 300 }),
      stat({ startupPrefix: 999_999, isSubagent: true }),
    ]);
    expect(value).toBe(200);
  });

  it('returns 0 when nothing recorded a prefix', () => {
    expect(medianStartupPrefix([])).toBe(0);
    expect(medianStartupPrefix([stat({ startupPrefix: 0 })])).toBe(0);
  });
});
