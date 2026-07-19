import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../src/commands/spawn.js';
import { buildStatusReport, collectStatus, status } from '../src/commands/status.js';
import { commitFile, makeTempRepo, worktreePath } from './helpers.js';
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

describe('fleet status', () => {
  it('reports ahead/behind, diff stat, and uncommitted files', async () => {
    await spawn('alice', { cwd: repo.root });
    const wt = worktreePath(repo.root, 'alice');
    await commitFile(wt, 'feature.txt', 'new\n', 'feat: add feature');
    writeFileSync(path.join(wt, 'scratch.txt'), 'wip\n');

    const result = await status('alice', { cwd: repo.root });

    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(0);
    expect(result.diffStat).toContain('feature.txt');
    expect(result.uncommitted.map((f) => f.path)).toContain('scratch.txt');
    expect(result.worktreeMissing).toBe(false);
  });

  it('shows behind counts when the base branch moves on', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(repo.root, 'main-moved.txt', 'x\n', 'feat: main moves on');

    const result = await status('alice', { cwd: repo.root });
    expect(result.behind).toBe(1);
    expect(result.ahead).toBe(0);
  });

  it('errors clearly for an unknown agent', async () => {
    await expect(status('ghost', { cwd: repo.root })).rejects.toThrow(/No agent named "ghost"/);
  });

  it('--json prints the result as parseable JSON', async () => {
    await spawn('alice', { cwd: repo.root });

    const result = await status('alice', { json: true, cwd: repo.root });

    const printed = JSON.parse(
      vi.mocked(console.log).mock.calls.at(-1)?.[0] as string,
    ) as typeof result;
    expect(printed).toEqual(result);
    expect(printed.record.name).toBe('alice');
  });
});

describe('collectStatus (pure core)', () => {
  it('returns the same result as status() while writing nothing to stdout', async () => {
    await spawn('alice', { cwd: repo.root });
    const wt = worktreePath(repo.root, 'alice');
    await commitFile(wt, 'feature.txt', 'new\n', 'feat: add feature');
    writeFileSync(path.join(wt, 'scratch.txt'), 'wip\n');

    const printed = await status('alice', { cwd: repo.root });
    vi.mocked(console.log).mockClear();

    const collected = await collectStatus('alice', { cwd: repo.root });

    expect(console.log).not.toHaveBeenCalled();
    expect(collected).toEqual(printed);
  });

  it('still rejects an unknown agent', async () => {
    await expect(collectStatus('ghost', { cwd: repo.root })).rejects.toThrow(
      /No agent named "ghost"/,
    );
  });
});

describe('buildStatusReport (pure renderer)', () => {
  it('renders the human summary without writing to stdout', async () => {
    await spawn('alice', { cwd: repo.root });
    const wt = worktreePath(repo.root, 'alice');
    await commitFile(wt, 'feature.txt', 'new\n', 'feat: add feature');
    const result = await collectStatus('alice', { cwd: repo.root });
    vi.mocked(console.log).mockClear();

    const report = buildStatusReport(result, wt);

    expect(console.log).not.toHaveBeenCalled();
    expect(report).toContain('Agent alice');
    expect(report).toContain('fleet/alice');
    expect(report).toContain('feature.txt');
  });
});
