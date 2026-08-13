import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { check, collectCheck } from '../src/commands/check.js';
import { spawn } from '../src/commands/spawn.js';
import { readConfig, resolveGuardedPath } from '../src/lib/config.js';
import { readState } from '../src/lib/state.js';
import { makeTempRepo } from './helpers.js';
import type { TempRepo } from './helpers.js';

let repo: TempRepo;
let shared: tmp.DirResult;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  repo = await makeTempRepo();
  // The whole point of a guarded path is that it lives outside the repository,
  // so the fixture does too.
  shared = tmp.dirSync({ unsafeCleanup: true, prefix: 'fleet-shared-' });
});

afterEach(() => {
  vi.restoreAllMocks();
  shared.removeCallback();
  repo.cleanup();
});

function sharedFile(name: string): string {
  return path.join(shared.name, name);
}

function configureGuarded(entries: string[]): void {
  writeFileSync(
    path.join(repo.root, '.fleetrc.json'),
    JSON.stringify({ guardedPaths: entries }),
  );
}

describe('guarded paths outside any worktree', () => {
  it('records a hash of every guarded path at spawn time', async () => {
    const pipeline = sharedFile('oss-pipeline.md');
    writeFileSync(pipeline, '# queue\n');
    configureGuarded([pipeline]);

    await spawn('alice', { cwd: repo.root });

    const guarded = readState(repo.root).agents['alice']?.guarded;
    expect(guarded).toBeDefined();
    expect(guarded?.[pipeline]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a guarded path that changed since an agent spawned', async () => {
    const pipeline = sharedFile('oss-pipeline.md');
    writeFileSync(pipeline, '# queue\n');
    configureGuarded([pipeline]);
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });

    // Another session appends to the shared file mid-run — the exact incident.
    writeFileSync(pipeline, '# queue\n- a new measured entry\n');

    const result = await check({ cwd: repo.root });

    expect(result.guardedChanges).toEqual([{ path: pipeline, agents: ['alice', 'bob'] }]);
    // A shared-file warning is not a merge collision; the exit code is unchanged.
    expect(result.collisions).toEqual([]);
  });

  it('says nothing while the guarded path is untouched', async () => {
    const pipeline = sharedFile('oss-pipeline.md');
    writeFileSync(pipeline, '# queue\n');
    configureGuarded([pipeline]);
    await spawn('alice', { cwd: repo.root });

    expect((await collectCheck({ cwd: repo.root })).guardedChanges).toEqual([]);
  });

  it('reports a guarded path that appeared after the agent spawned', async () => {
    const settings = sharedFile('settings.json');
    configureGuarded([settings]);
    await spawn('alice', { cwd: repo.root });

    writeFileSync(settings, '{}\n');

    expect((await collectCheck({ cwd: repo.root })).guardedChanges).toEqual([
      { path: settings, agents: ['alice'] },
    ]);
  });

  it('stays quiet about a path that is absent both times', async () => {
    configureGuarded([sharedFile('never-created.md')]);
    await spawn('alice', { cwd: repo.root });

    expect((await collectCheck({ cwd: repo.root })).guardedChanges).toEqual([]);
  });

  it('only names the agents whose recorded hash is stale', async () => {
    const notes = sharedFile('CLAUDE.md');
    writeFileSync(notes, 'v1\n');
    configureGuarded([notes]);
    await spawn('alice', { cwd: repo.root });

    // bob spawns after the edit, so bob's recorded hash is already current.
    writeFileSync(notes, 'v2\n');
    await spawn('bob', { cwd: repo.root });

    expect((await collectCheck({ cwd: repo.root })).guardedChanges).toEqual([
      { path: notes, agents: ['alice'] },
    ]);
  });

  it('omits the field entirely when no guarded paths are configured', async () => {
    await spawn('alice', { cwd: repo.root });
    expect((await collectCheck({ cwd: repo.root })).guardedChanges).toBeUndefined();
  });

  it('reports guarded changes in the human output', async () => {
    const pipeline = sharedFile('oss-pipeline.md');
    writeFileSync(pipeline, '# queue\n');
    configureGuarded([pipeline]);
    await spawn('alice', { cwd: repo.root });
    writeFileSync(pipeline, '# queue\n- entry\n');

    await check({ cwd: repo.root });

    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toMatch(/oss-pipeline\.md/);
    expect(printed).toMatch(/outside any worktree|guarded/i);
  });

  it('survives a guarded path that is a directory rather than a file', async () => {
    const dir = sharedFile('a-directory');
    mkdirSync(dir);
    configureGuarded([dir]);

    await spawn('alice', { cwd: repo.root });
    const result = await collectCheck({ cwd: repo.root });

    expect(result.guardedChanges).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('guardedPaths config', () => {
  it('rejects anything that is not an array of non-empty strings', () => {
    for (const bad of ['x', [''], [3], {}]) {
      writeFileSync(
        path.join(repo.root, '.fleetrc.json'),
        JSON.stringify({ guardedPaths: bad }),
      );
      expect(() => readConfig(repo.root)).toThrow(/guardedPaths/);
    }
  });

  it('accepts an array of paths', () => {
    configureGuarded([sharedFile('a.md'), sharedFile('b.md')]);
    expect(readConfig(repo.root).guardedPaths).toHaveLength(2);
  });
});

describe('resolveGuardedPath (pure)', () => {
  it('expands ~ to the home directory', () => {
    expect(resolveGuardedPath('~/Github/oss-pipeline.md', '/repo')).toBe(
      path.join(os.homedir(), 'Github', 'oss-pipeline.md'),
    );
  });

  it('resolves a relative entry against the repo root', () => {
    expect(resolveGuardedPath('../shared/notes.md', path.join(path.sep, 'repo'))).toBe(
      path.resolve(path.join(path.sep, 'repo'), '../shared/notes.md'),
    );
  });

  it('leaves an absolute path alone', () => {
    const abs = path.join(path.sep, 'tmp', 'notes.md');
    expect(resolveGuardedPath(abs, '/repo')).toBe(path.resolve(abs));
  });
});
