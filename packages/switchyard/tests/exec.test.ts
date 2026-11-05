import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exec } from '../src/commands/exec.js';
import { spawn } from '../src/commands/spawn.js';
import { shellJoin } from '../src/lib/proc.js';
import { makeTempRepo, worktreePath } from './helpers.js';
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

/** A script that writes a marker file into its cwd — proof of where it ran. */
function writeMarkerScript(): string {
  const script = path.join(repo.root, 'mark.cjs');
  writeFileSync(script, "require('fs').writeFileSync('made-by-exec.txt', 'ok');\n");
  return script;
}

describe('fleet exec', () => {
  it('runs the command inside the agent worktree, not the main checkout', async () => {
    await spawn('alice', { cwd: repo.root });
    const script = writeMarkerScript();

    const result = await exec('alice', ['node', script], { cwd: repo.root });

    expect(result.ok).toBe(true);
    expect(result.outcomes).toEqual([{ name: 'alice', exitCode: 0 }]);
    expect(existsSync(path.join(worktreePath(repo.root, 'alice'), 'made-by-exec.txt'))).toBe(true);
    expect(existsSync(path.join(repo.root, 'made-by-exec.txt'))).toBe(false);
  });

  it('--all runs in every agent worktree', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    const script = writeMarkerScript();

    const result = await exec(undefined, ['node', script], { all: true, cwd: repo.root });

    expect(result.outcomes.map((o) => o.name)).toEqual(['alice', 'bob']);
    for (const agent of ['alice', 'bob']) {
      expect(existsSync(path.join(worktreePath(repo.root, agent), 'made-by-exec.txt'))).toBe(true);
    }
  });

  it('propagates a non-zero exit code', async () => {
    await spawn('alice', { cwd: repo.root });
    const script = path.join(repo.root, 'exit3.cjs');
    writeFileSync(script, 'process.exit(3);\n');

    const result = await exec('alice', ['node', script], { cwd: repo.root });

    expect(result.ok).toBe(false);
    expect(result.outcomes).toEqual([{ name: 'alice', exitCode: 3 }]);
  });

  it('errors on an unknown agent and on an empty command', async () => {
    await spawn('alice', { cwd: repo.root });
    await expect(exec('ghost', ['node', '-v'], { cwd: repo.root })).rejects.toThrow(
      /No agent named "ghost"/,
    );
    await expect(exec('alice', [], { cwd: repo.root })).rejects.toThrow(/No command given/);
  });

  it('shellJoin quotes only the tokens that need it', () => {
    expect(shellJoin(['npm', 'run', 'lint'])).toBe('npm run lint');
    expect(shellJoin(['node', '-e', 'console.log(1)'])).toBe('node -e "console.log(1)"');
    expect(shellJoin(['echo', 'two words'])).toBe('echo "two words"');
  });
});
