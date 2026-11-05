import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregate, monthlyProjection } from '../aggregate.js';
import { cacheWriteMultiplier } from '../cost.js';
import { renderReport } from '../report.js';
import { scanAll } from '../scan.js';
import type { PriceTable } from '../types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;
const stats = scanAll(path.join(root, 'fixtures', 'projects'));

function run(ttl: '5m' | '1h' = '5m'): ReturnType<typeof aggregate> {
  return aggregate(stats, { table, ttl, cacheWriteMult: cacheWriteMultiplier(table, ttl) });
}

describe('end-to-end over fixtures', () => {
  const report = run();

  it('prices the whole corpus to a hand-checkable total', () => {
    // Worked by hand from prices.json at the 5m cache rate (write 1.25x, read 0.1x):
    //   session-a  opus-5    15in/1000cw/1000cr/70out  = $0.008575
    //     15*5 + 1000*5*1.25 + 1000*5*0.1 + 70*25, /1e6
    //   session-a  sonnet-5   2in/0cw/1000cr/10out     = $0.000304
    //     2*2 + 1000*2*0.1 + 10*10, /1e6
    //   session-b  haiku-4-5 100in/0cw/0cr/10out       = $0.000150
    //   session-b  opus-5 FAST      0/0/0/100out       = $0.005000
    //   agent      opus-5     7in/500cw/0cr/5out       = $0.003285
    //   dead       opus-5     3in/80cw/0cr/1out        = $0.000540
    //                                            total = $0.017854
    //
    // Was $0.018006 until 2026-08-28, when Sonnet 5 was corrected from $3/$15 to its
    // actual $2/$10 (that row alone moved by $0.000152). Re-derived above line by line
    // rather than re-baselined to what the code emits, which is the only way this
    // assertion keeps telling a deliberate rate change apart from a silent regression.
    expect(report.cost.total).toBeCloseTo(0.017854, 9);
  });

  it('counts sessions and subagents separately', () => {
    expect(report.transcriptCount).toBe(4);
    expect(report.sessionCount).toBe(3); // the nested subagent is excluded
    expect(report.turns).toBe(7);
  });

  it('leaves no model unpriced', () => {
    expect(report.unpricedModelsSeen).toEqual([]);
  });

  it('reports the median startup prefix across main sessions', () => {
    // prefixes are 1010 (session-a), 100 (session-b), 83 (dead) -> median 100
    expect(report.findings.medianStartupPrefix).toBe(100);
  });

  it('charges more under the 1h cache assumption than the 5m default', () => {
    // The default must be the conservative one — a report that overstates cost
    // is a worse failure than one that understates it and says so.
    expect(run('1h').cost.total).toBeGreaterThan(report.cost.total);
  });

  it('splits fast-mode usage into its own model row', () => {
    const fastRow = report.byModel.find((m) => m.model.includes('(fast)'));
    expect(fastRow?.usd).toBeCloseTo(0.005, 9);
  });

  it('category shares account for the total exactly', () => {
    // Exact by construction: prefix is capped at non-output spend, so
    // prefix + content + output == total with no leakage. A drift here means
    // some cost is being counted twice or dropped.
    const shares = report.byCategory.reduce((a, b) => a + b.share, 0);
    expect(shares).toBeCloseTo(100, 6);
    const dollars = report.byCategory.reduce((a, b) => a + b.usd, 0);
    expect(dollars).toBeCloseTo(report.cost.total, 9);
  });

  it('flags the dead run', () => {
    // Fixtures are tiny by construction, so more than one qualifies here;
    // on a real corpus a genuine session is orders of magnitude larger.
    expect(report.findings.deadRuns.map((d) => d.id)).toContain('dead');
  });

  it('projects a monthly figure without dividing by zero', () => {
    expect(Number.isFinite(monthlyProjection(report))).toBe(true);
    expect(monthlyProjection(report)).toBeGreaterThan(0);
  });
});

describe('aggregate on an empty corpus', () => {
  it('produces a zeroed report rather than NaN', () => {
    const empty = aggregate([], { table, ttl: '5m', cacheWriteMult: 1.25 });
    expect(empty.cost.total).toBe(0);
    expect(empty.turns).toBe(0);
    expect(empty.findings.medianStartupPrefix).toBe(0);
    expect(Number.isFinite(monthlyProjection(empty))).toBe(true);
  });
});

describe('renderReport', () => {
  const html = renderReport(run());

  it('produces a complete standalone document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('references no external host — the zero-egress claim is testable', () => {
    // A single remote asset would leak that the report was opened, and would
    // break the offline promise the product is sold on.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
  });

  it('escapes values that reach the page', () => {
    const report = run();
    const hostile = {
      ...report,
      topSessions: [
        {
          id: '<img src=x onerror=alert(1)>',
          project: '"><script>bad()</script>',
          turns: 1,
          usd: 1,
          usdPerTurn: 1,
          producedFile: false,
          startupPrefix: 0,
          startedAt: null,
          bytes: 1,
        },
      ],
    };
    const out = renderReport(hostile);
    // The project name is rendered in full, so it is the real test of escaping.
    expect(out).not.toContain('<script>bad()');
    expect(out).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(out).toContain('&quot;&gt;');
    // Session ids are truncated to 8 chars for display, then escaped.
    expect(out).toContain('&lt;img src');
    expect(out).not.toContain('<img src');
  });

  it('states the price table date and the cache assumption', () => {
    expect(html).toContain(table.dated);
    expect(html).toContain('5m');
  });
});

/**
 * Project rows have to reconcile with the corpus, or they are decoration.
 *
 * The reason to be careful here is `startupPrefixUsd`: it is a model capped at
 * each session's non-output spend, not a billed line, so it survives being
 * summed only because the per-session capped values are what get accumulated.
 * Recomputing a prefix from pooled project aggregates would not reconcile, and
 * nothing else in the suite would notice.
 */
describe('byProject', () => {
  const report = run();

  it('sums to the corpus total exactly', () => {
    const summed = report.byProject.reduce((n, p) => n + p.usd, 0);
    expect(summed).toBeCloseTo(report.cost.total, 12);
  });

  it('sums turns and the fixed-context figure back to the whole', () => {
    expect(report.byProject.reduce((n, p) => n + p.turns, 0)).toBe(report.turns);
    expect(report.byProject.reduce((n, p) => n + p.sessions, 0)).toBe(report.sessionCount);
    expect(report.byProject.reduce((n, p) => n + p.transcripts, 0)).toBe(report.transcriptCount);
    expect(report.byProject.reduce((n, p) => n + p.startupPrefixUsd, 0)).toBeCloseTo(
      report.findings.startupPrefixUsd,
      12,
    );
  });

  it('counts a subagent toward its project without counting it as a session', () => {
    // The subagent lives under demo-project, so that row carries three
    // transcripts and two sessions. Conflating the two is how sessionCount
    // silently inflates.
    const demo = report.byProject.find((p) => p.project.includes('demo-project'));
    expect(demo?.transcripts).toBe(3);
    expect(demo?.sessions).toBe(2);
  });

  it('orders projects by cost and shares total 100%', () => {
    const shares = report.byProject.reduce((n, p) => n + p.share, 0);
    expect(shares).toBeCloseTo(100, 6);
    const usds = report.byProject.map((p) => p.usd);
    expect([...usds].sort((a, b) => b - a)).toEqual(usds);
  });
});
