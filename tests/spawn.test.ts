import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../src/commands/spawn.js';
import { branchExists, gitAt } from '../src/lib/git.js';
import { readState } from '../src/lib/state.js';
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

describe('fleet spawn', () => {
  it('creates a worktree, a fleet/<name> branch, and a state record', async () => {
    const result = await spawn('alice', { cwd: repo.root });

    expect(result.worktreePath).toBe(worktreePath(repo.root, 'alice'));
    expect(existsSync(result.worktreePath)).toBe(true);
    // The worktree starts with the base branch's content.
    expect(existsSync(path.join(result.worktreePath, 'README.md'))).toBe(true);
    expect(await branchExists(gitAt(repo.root), 'fleet/alice')).toBe(true);

    const state = readState(repo.root);
    expect(state.agents['alice']).toMatchObject({
      name: 'alice',
      branch: 'fleet/alice',
      baseBranch: 'main',
      worktreePath: '.fleet/worktrees/alice',
    });
  });

  it('spawns from a --from branch instead of the current branch', async () => {
    await repo.git.checkoutLocalBranch('dev');
    await commitFile(repo.root, 'dev-only.txt', 'dev\n', 'feat: dev-only file');
    await repo.git.checkout('main');

    const result = await spawn('bob', { from: 'dev', cwd: repo.root });

    expect(existsSync(path.join(result.worktreePath, 'dev-only.txt'))).toBe(true);
    expect(readState(repo.root).agents['bob']?.baseBranch).toBe('dev');
  });

  it('rejects a duplicate agent name instead of overwriting', async () => {
    await spawn('alice', { cwd: repo.root });
    await expect(spawn('alice', { cwd: repo.root })).rejects.toThrow(/already exists/);
  });

  it('rejects an untracked pre-existing fleet/<name> branch', async () => {
    await repo.git.raw(['branch', 'fleet/rogue']);
    await expect(spawn('rogue', { cwd: repo.root })).rejects.toThrow(/not tracked by Switchyard/);
  });

  it('rejects invalid agent names', async () => {
    await expect(spawn('../evil', { cwd: repo.root })).rejects.toThrow(/Invalid agent name/);
    await expect(spawn('has space', { cwd: repo.root })).rejects.toThrow(/Invalid agent name/);
  });

  it('rejects a missing --from branch', async () => {
    await expect(spawn('alice', { from: 'no-such-branch', cwd: repo.root })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('fails with a clear error outside a git repository', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    await expect(spawn('alice', { cwd: dir.name })).rejects.toThrow(
      /Not inside a git repository/,
    );
    dir.removeCallback();
  });
});

describe('fleet spawn provisioning (.fleetrc.json)', () => {
  it('copies copyOnSpawn entries into the new worktree, skipping missing ones', async () => {
    writeFileSync(path.join(repo.root, '.env'), 'SECRET=1\n');
    writeFileSync(
      path.join(repo.root, '.fleetrc.json'),
      JSON.stringify({ copyOnSpawn: ['.env', 'missing.txt'] }),
    );

    const result = await spawn('alice', { cwd: repo.root });

    expect(result.copied).toEqual(['.env']);
    expect(existsSync(path.join(result.worktreePath, '.env'))).toBe(true);
  });

  it('runs the postSpawn hook inside the worktree', async () => {
    const script = path.join(repo.root, 'setup.cjs');
    writeFileSync(script, "require('fs').writeFileSync('setup-ran.txt', 'ok');\n");
    writeFileSync(
      path.join(repo.root, '.fleetrc.json'),
      JSON.stringify({ postSpawn: `node ${script}` }),
    );

    const result = await spawn('alice', { cwd: repo.root });

    expect(result.postSpawnExitCode).toBe(0);
    expect(existsSync(path.join(result.worktreePath, 'setup-ran.txt'))).toBe(true);
  });

  it('keeps the worktree and state when the postSpawn hook fails', async () => {
    const script = path.join(repo.root, 'boom.cjs');
    writeFileSync(script, 'process.exit(2);\n');
    writeFileSync(
      path.join(repo.root, '.fleetrc.json'),
      JSON.stringify({ postSpawn: `node ${script}` }),
    );

    const result = await spawn('alice', { cwd: repo.root });

    expect(result.postSpawnExitCode).toBe(2);
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(readState(repo.root).agents['alice']).toBeDefined();
  });
});
