import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completion } from '../src/commands/completion.js';
import { spawn } from '../src/commands/spawn.js';
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

describe('fleet completion', () => {
  it('covers command names and current agent names for every shell', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });

    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = await completion(shell, { cwd: repo.root });
      for (const command of ['spawn', 'merge', 'doctor', 'watch', 'completion', 'sync', 'exec', 'pr']) {
        expect(script, `${shell} should list "${command}"`).toContain(command);
      }
      expect(script).toContain('alice');
      expect(script).toContain('bob');
      expect(script).toContain('snapshot');
    }
  });

  it('still generates a script outside a git repository (no agent names)', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const script = await completion('bash', { cwd: dir.name });
    expect(script).toContain('spawn');
    dir.removeCallback();
  });

  it('rejects an unsupported shell', async () => {
    await expect(completion('powershell', { cwd: repo.root })).rejects.toThrow(
      /Unsupported shell "powershell"/,
    );
  });
});
