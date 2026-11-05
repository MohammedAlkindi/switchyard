import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { list } from '../src/commands/list.js';
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

describe('fleet list', () => {
  it('returns nothing when no agents exist', async () => {
    expect(await list({ cwd: repo.root })).toEqual([]);
  });

  it('reports ahead/behind, uncommitted counts, and last activity per agent', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });

    // alice commits a file; bob edits a tracked file without committing.
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'new\n', 'feat: feature');
    writeFileSync(path.join(worktreePath(repo.root, 'bob'), 'src.txt'), 'edited\n');

    const listings = await list({ cwd: repo.root });
    expect(listings).toHaveLength(2);

    const alice = listings.find((l) => l.name === 'alice');
    const bob = listings.find((l) => l.name === 'bob');
    expect(alice).toMatchObject({ ahead: 1, behind: 0, uncommitted: 0, worktreeMissing: false });
    expect(bob).toMatchObject({ ahead: 0, behind: 0, uncommitted: 1, worktreeMissing: false });
    expect(alice?.lastActivity).toBeTruthy();
    expect(bob?.lastActivity).toBeTruthy();
  });

  it('flags a manually deleted worktree instead of crashing', async () => {
    await spawn('alice', { cwd: repo.root });
    rmSync(worktreePath(repo.root, 'alice'), { recursive: true, force: true });

    const listings = await list({ cwd: repo.root });
    expect(listings[0]?.worktreeMissing).toBe(true);
  });

  it('reports validation state relative to the current tip', async () => {
    const configFile = path.join(repo.root, '.fleetrc.json');
    writeFileSync(configFile, '{ "validate": "node -e \\"process.exit(0)\\"" }');
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });

    // Nobody validated yet.
    let listings = await list({ cwd: repo.root });
    expect(listings.map((l) => l.validation)).toEqual(['none', 'none']);

    // alice passes; bob is left unvalidated.
    await validate('alice', { cwd: repo.root });
    listings = await list({ cwd: repo.root });
    expect(listings.find((l) => l.name === 'alice')).toMatchObject({ validation: 'passed' });
    expect(listings.find((l) => l.name === 'alice')?.validatedAt).toBeTruthy();
    expect(listings.find((l) => l.name === 'bob')).toMatchObject({
      validation: 'none',
      validatedAt: null,
    });

    // New work on top of the validated commit makes the record stale.
    await commitFile(worktreePath(repo.root, 'alice'), 'more.txt', 'm\n', 'feat: more');
    listings = await list({ cwd: repo.root });
    expect(listings.find((l) => l.name === 'alice')).toMatchObject({ validation: 'stale' });

    // So does changing the configured command, even at the same tip.
    await validate('alice', { cwd: repo.root });
    writeFileSync(configFile, '{ "validate": "node -e \\"process.exit(2)\\"" }');
    listings = await list({ cwd: repo.root });
    expect(listings.find((l) => l.name === 'alice')).toMatchObject({ validation: 'stale' });
  });

  it('reports a failing record as failed until the tip moves', async () => {
    writeFileSync(
      path.join(repo.root, '.fleetrc.json'),
      '{ "validate": "node -e \\"process.exit(1)\\"" }',
    );
    await spawn('alice', { cwd: repo.root });
    await validate('alice', { cwd: repo.root });

    const listings = await list({ cwd: repo.root });
    expect(listings[0]).toMatchObject({ validation: 'failed' });
  });

  it('--json prints the listings as parseable JSON', async () => {
    await spawn('alice', { cwd: repo.root });

    const listings = await list({ json: true, cwd: repo.root });

    const printed = JSON.parse(
      vi.mocked(console.log).mock.calls.at(-1)?.[0] as string,
    ) as typeof listings;
    expect(printed).toEqual(listings);
    expect(printed[0]).toMatchObject({ name: 'alice', branch: 'fleet/alice' });
  });
});
