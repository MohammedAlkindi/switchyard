import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDashboard, collectDashboard, dashboard } from '../src/commands/dashboard.js';
import { spawn } from '../src/commands/spawn.js';
import { validate } from '../src/commands/validate.js';
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

/** Strip ANSI color codes so assertions read the visible text. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('fleet dashboard', () => {
  it('composes the agent table, file counts, validation tally, and collision report', async () => {
    writeFileSync(
      path.join(repo.root, '.fleetrc.json'),
      '{ "validate": "node -e \\"process.exit(0)\\"" }',
    );
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    // Both edit the same file with committed work — a real collision.
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: a');
    await commitFile(worktreePath(repo.root, 'bob'), 'src.txt', 'bob\n', 'feat: b');
    await validate('alice', { cwd: repo.root });

    const frame = plain(buildDashboard(await collectDashboard(repo.root)));

    expect(frame).toContain('fleet dashboard');
    expect(frame).toContain('alice');
    expect(frame).toContain('bob');
    // Both agents touched exactly one file each.
    expect(frame).toContain('files touched vs base: alice 1 · bob 1');
    // One validated, one not.
    expect(frame).toContain('1 passed');
    expect(frame).toContain('1 unvalidated');
    // The collision report names the shared file.
    expect(frame).toContain('src.txt');
    expect(frame).toMatch(/collision risk|touched by more than one agent/);
  });

  it('reports an empty fleet without running any collision analysis', async () => {
    const frame = plain(buildDashboard(await collectDashboard(repo.root)));
    expect(frame).toContain('No active agents');
  });

  it('shows file counts for a single agent even though nothing can collide', async () => {
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'a.txt', 'a\n', 'feat: a');

    const frame = plain(buildDashboard(await collectDashboard(repo.root)));

    expect(frame).toContain('files touched vs base: alice 1');
    expect(frame).toContain('Nothing to check');
  });

  it('--once prints exactly one frame and returns', async () => {
    await spawn('alice', { cwd: repo.root });
    vi.mocked(console.log).mockClear();

    await dashboard({ once: true, cwd: repo.root });

    const calls = vi.mocked(console.log).mock.calls;
    expect(calls).toHaveLength(1);
    expect(plain(String(calls[0]?.[0]))).toContain('fleet dashboard');
  });
});
