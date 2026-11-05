import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { list } from '../src/commands/list.js';
import { spawn } from '../src/commands/spawn.js';
import { renderWatchFrame, resolveWatchInterval } from '../src/commands/watch.js';
import { makeTempRepo } from './helpers.js';
import type { TempRepo } from './helpers.js';

let repo: TempRepo;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  repo = await makeTempRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  repo.cleanup();
});

describe('fleet watch', () => {
  it('renders a frame with the same table data as fleet list', async () => {
    await spawn('alice', { cwd: repo.root });

    const frame = await renderWatchFrame({ cwd: repo.root });

    expect(frame).toContain('fleet watch');
    expect(frame).toContain('Ctrl+C to exit');
    expect(frame).toContain('alice');
    expect(frame).toContain('fleet/alice');
    // Same rendering path as `fleet list`: the frame embeds the identical table.
    const logSpy = vi.mocked(console.log);
    logSpy.mockClear();
    await list({ cwd: repo.root });
    const listTable = logSpy.mock.calls[0]?.[0] as string;
    expect(frame).toContain(listTable);
  });

  it('renders the empty-state message when no agents exist', async () => {
    const frame = await renderWatchFrame({ cwd: repo.root });
    expect(frame).toContain('No active agents');
  });

  it('resolves the interval with flag > config > default precedence', () => {
    expect(resolveWatchInterval(undefined, {})).toBe(3);
    expect(resolveWatchInterval(undefined, { watchInterval: 1.5 })).toBe(1.5);
    expect(resolveWatchInterval(5, { watchInterval: 1.5 })).toBe(5);
  });

  it('rejects a non-positive or non-numeric interval', () => {
    expect(() => resolveWatchInterval(0, {})).toThrow(/positive number/);
    expect(() => resolveWatchInterval(-2, {})).toThrow(/positive number/);
    expect(() => resolveWatchInterval(Number.NaN, {})).toThrow(/positive number/);
  });
});
