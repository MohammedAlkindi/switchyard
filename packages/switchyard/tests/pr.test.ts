import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pr } from '../src/commands/pr.js';
import { spawn } from '../src/commands/spawn.js';
import { commitFile, makeTempRepo, worktreePath } from './helpers.js';
import type { TempRepo } from './helpers.js';

let repo: TempRepo;
let bare: tmp.DirResult;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  repo = await makeTempRepo();
  // A local bare repository stands in for GitHub as the push target; the gh
  // CLI itself is a network tool, so tests substitute a recording stub via
  // the FLEET_GH hook instead of mocking git.
  bare = tmp.dirSync({ unsafeCleanup: true, prefix: 'fleet-origin-' });
  await simpleGit({ baseDir: bare.name }).init(true);
});

afterEach(() => {
  delete process.env.FLEET_GH;
  vi.restoreAllMocks();
  bare.removeCallback();
  repo.cleanup();
});

async function addOrigin(): Promise<void> {
  await repo.git.addRemote('origin', bare.name);
}

/** Stub gh: records its argv into gh-args.json next to itself and exits 0. */
function stubGh(): string {
  const script = path.join(repo.root, 'fake-gh.cjs');
  writeFileSync(
    script,
    "require('fs').writeFileSync(require('path').join(__dirname, 'gh-args.json'), JSON.stringify(process.argv.slice(2)));\n",
  );
  process.env.FLEET_GH = `node ${script}`;
  return path.join(repo.root, 'gh-args.json');
}

async function branchOnOrigin(branch: string): Promise<boolean> {
  const out = await simpleGit({ baseDir: bare.name }).raw(['branch', '--list', branch]);
  return out.trim().length > 0;
}

describe('fleet pr', () => {
  it('pushes the branch to origin and calls gh pr create', async () => {
    await addOrigin();
    const argsFile = stubGh();
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    const result = await pr('alice', { cwd: repo.root });

    expect(result).toEqual({ branch: 'fleet/alice', base: 'main', pushed: true, created: true });
    expect(await branchOnOrigin('fleet/alice')).toBe(true);
    const ghArgs = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    expect(ghArgs).toEqual(['pr', 'create', '--head', 'fleet/alice', '--base', 'main', '--fill']);
  });

  it('passes --title, --base, and --draft through to gh', async () => {
    await addOrigin();
    const argsFile = stubGh();
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    await pr('alice', { title: 'feat: my feature', base: 'dev', draft: true, cwd: repo.root });

    const ghArgs = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    expect(ghArgs).toEqual([
      'pr', 'create',
      '--head', 'fleet/alice',
      '--base', 'dev',
      '--title', 'feat: my feature',
      '--body', '',
      '--draft',
    ]);
  });

  it('fails before pushing when gh is not available', async () => {
    await addOrigin();
    process.env.FLEET_GH = 'fleet-test-no-such-binary-xyz';
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    await expect(pr('alice', { cwd: repo.root })).rejects.toThrow(/GitHub CLI \(gh\) not found/);
    expect(await branchOnOrigin('fleet/alice')).toBe(false);
  });

  it('refuses without an origin remote', async () => {
    stubGh();
    await spawn('alice', { cwd: repo.root });
    await expect(pr('alice', { cwd: repo.root })).rejects.toThrow(/No "origin" remote/);
  });

  it('errors clearly for an unknown agent', async () => {
    await addOrigin();
    stubGh();
    await expect(pr('ghost', { cwd: repo.root })).rejects.toThrow(/No agent named "ghost"/);
  });
});
