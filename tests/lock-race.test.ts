import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState } from '../src/lib/state.js';
import { makeTempRepo, worktreePath } from './helpers.js';
import type { TempRepo } from './helpers.js';

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

let repo: TempRepo;

beforeEach(async () => {
  repo = await makeTempRepo();
});

afterEach(() => {
  repo.cleanup();
});

describe('inter-process locking', () => {
  it('two concurrent `fleet spawn` processes both register', async () => {
    // Without the lock this is the lost-update race: both read empty state,
    // both write, last writer wins, one agent vanishes.
    await Promise.all([
      execFileP(process.execPath, [CLI, 'spawn', 'alice'], { cwd: repo.root }),
      execFileP(process.execPath, [CLI, 'spawn', 'bob'], { cwd: repo.root }),
    ]);

    expect(Object.keys(readState(repo.root).agents).sort()).toEqual(['alice', 'bob']);
    expect(existsSync(worktreePath(repo.root, 'alice'))).toBe(true);
    expect(existsSync(worktreePath(repo.root, 'bob'))).toBe(true);
  });
});
