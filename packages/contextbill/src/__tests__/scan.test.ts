import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanAll } from '../scan.js';
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
