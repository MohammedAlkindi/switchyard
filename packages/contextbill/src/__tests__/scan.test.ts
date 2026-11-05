import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectLayout, scanAll, scanCorpus, scanFile } from '../scan.js';
import type { SessionStat } from '../types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(root, 'fixtures', 'projects');

const stats = scanAll(FIXTURES);
function byId(id: string): SessionStat {
  const found = stats.find((s) => s.id === id);
  if (!found) throw new Error(`fixture ${id} not scanned`);
  return found;
}

describe('scanAll', () => {
  it('finds every transcript including nested ones', () => {
    expect(stats.map((s) => s.id).sort()).toEqual(['agent', 'dead', 'session-a', 'session-b']);
  });

  it('marks nested transcripts as subagents and top-level ones as sessions', () => {
    expect(byId('agent').isSubagent).toBe(true);
    expect(byId('session-a').isSubagent).toBe(false);
  });

  it('attributes the project directory', () => {
    expect(byId('session-a').project).toBe('demo-project');
    expect(byId('dead').project).toBe('dead-project');
  });
});

describe('scanFile totals', () => {
  const a = byId('session-a');

  it('counts only lines that carry usage as turns', () => {
    // Six valid lines, three of which are billed turns; the seventh is
    // deliberately malformed and must be skipped without throwing.
    expect(a.turns).toBe(3);
  });

  it('sums the four token classes', () => {
    expect(a.usage).toEqual({ input: 17, cacheWrite: 1000, cacheRead: 2000, output: 80 });
  });

  it('reads the startup prefix from the first turn only', () => {
    // cache_read + cache_creation + input on turn 1 = 0 + 1000 + 10.
    // Later turns re-read the same block; counting them would multiply it.
    expect(a.startupPrefix).toBe(1010);
  });

  it('attributes tool result bytes to the right category via the pending id map', () => {
    expect(a.toolBytes.files).toBe(12); // "0123456789" (10) + "ok" (2)
    expect(a.toolBytes.shell).toBe(5); // "abcde"
  });

  it('detects that a file was written', () => {
    expect(a.producedFile).toBe(true);
    expect(a.fileWrites).toBe(1);
    expect(byId('session-b').producedFile).toBe(false);
  });

  it('splits usage per model', () => {
    const opus = a.byModel.find((m) => m.model === 'claude-opus-5');
    const sonnet = a.byModel.find((m) => m.model === 'claude-sonnet-5');
    expect(opus?.turns).toBe(2);
    expect(opus?.usage).toEqual({ input: 15, cacheWrite: 1000, cacheRead: 1000, output: 70 });
    expect(sonnet?.turns).toBe(1);
  });

  it('records first and last timestamps', () => {
    expect(a.startedAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'));
    expect(a.endedAt).toBe(Date.parse('2026-08-01T10:00:25.000Z'));
  });

  it('separates fast-mode turns from standard ones', () => {
    const b = byId('session-b');
    const fast = b.byModel.find((m) => m.speed === 'fast');
    expect(fast?.model).toBe('claude-opus-5');
    expect(fast?.usage.output).toBe(100);
  });

  it('gives subagents no startup prefix', () => {
    // Subagents inherit context rather than loading their own; charging them a
    // prefix would double-count the parent session's.
    expect(byId('agent').startupPrefix).toBe(0);
  });

  it('records transcript size for the dead-run signal', () => {
    expect(byId('dead').bytes).toBeGreaterThan(0);
    expect(byId('dead').bytes).toBeLessThan(4096);
  });
});

/**
 * Pointing `--root` one level in used to misreport rather than fail.
 *
 * `fixtures/projects/demo-project` is exactly that shape: two sessions at depth
 * 1 and a subagent at depth 2. Under the old fixed session depth every project
 * resolved to 'unknown', and the subagent — sitting at the depth a session
 * normally occupies — was counted as a session, inflating sessionCount. Both
 * were silent, which is the failure mode this codebase is built to avoid.
 */
describe('scanning a single project directory', () => {
  const PROJECT_DIR = path.join(FIXTURES, 'demo-project');
  const { stats: inner, layout } = scanCorpus(PROJECT_DIR);

  it('detects that the root is one project, not a projects root', () => {
    expect(layout.singleProject).toBe(true);
    expect(layout.sessionDepth).toBe(1);
  });

  it('names the project after the directory instead of "unknown"', () => {
    expect(inner.every((s) => s.project === 'demo-project')).toBe(true);
  });

  it('still recognises the nested transcript as a subagent', () => {
    const agent = inner.find((s) => s.id === 'agent');
    expect(agent?.isSubagent).toBe(true);
    const sessionA = inner.find((s) => s.id === 'session-a');
    expect(sessionA?.isSubagent).toBe(false);
  });

  it('prices the same transcripts to the same total from either root', () => {
    // The layout changes what a file is called, never what it cost. If these
    // ever diverge, the depth logic has started dropping or duplicating turns.
    const fromProjectsRoot = stats
      .filter((s) => s.id !== 'dead')
      .reduce((n, s) => n + s.turns, 0);
    const fromProjectDir = inner.reduce((n, s) => n + s.turns, 0);
    expect(fromProjectDir).toBe(fromProjectsRoot);
  });
});

describe('detectLayout', () => {
  it('assumes the standard depth when there is nothing to measure', () => {
    expect(detectLayout('/anywhere', []).sessionDepth).toBe(2);
    expect(detectLayout('/anywhere', []).singleProject).toBe(false);
  });
});

/**
 * A transcript that cannot be read is not a transcript with nothing in it.
 *
 * `scanFile` returns an empty stat on a read failure so its signature holds for
 * any existing caller, which is exactly how an unreadable file used to be
 * counted as an empty one — indistinguishable in the output, and inflating
 * transcriptCount while it hid the failure. `scanCorpus` now drops it and
 * reports it, the same shape the browser reader settled on.
 */
describe('unreadable transcripts', () => {
  it('hands the reason out rather than swallowing it', () => {
    const reasons: string[] = [];
    const stat = scanFile(
      path.join(FIXTURES, 'no-such-project', 'missing.jsonl'),
      2,
      'no-such-project',
      2,
      (r) => reasons.push(r),
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.length).toBeGreaterThan(0);
    // The empty stat is still returned, which is the behaviour that made this
    // invisible before. It is the caller's job not to count it.
    expect(stat.turns).toBe(0);
  });

  it('reports nothing unreadable for a corpus that reads cleanly', () => {
    expect(scanCorpus(FIXTURES).unreadable).toEqual([]);
  });

  it('keeps stats and unreadable disjoint', () => {
    const { stats: all, unreadable } = scanCorpus(FIXTURES);
    const paths = new Set(all.map((s) => s.file));
    for (const u of unreadable) expect(paths.has(u.path)).toBe(false);
  });
});
