import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivePublicBranch, pr } from '../src/commands/pr.js';
import { spawn } from '../src/commands/spawn.js';
import { readState } from '../src/lib/state.js';
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

async function branchesOnOrigin(): Promise<string[]> {
  const out = await simpleGit({ baseDir: bare.name }).raw([
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean).sort();
}

describe('fleet pr', () => {
  it('publishes a task-derived branch name, never the agent branch', async () => {
    await addOrigin();
    const argsFile = stubGh();
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    const result = await pr('alice', { cwd: repo.root });

    expect(result).toEqual({
      branch: 'fleet/alice',
      publicBranch: 'feat/feature',
      base: 'main',
      pushed: true,
      created: true,
    });
    // The head ref GitHub renders in the PR header must not name the agent.
    expect(await branchOnOrigin('feat/feature')).toBe(true);
    expect(await branchOnOrigin('fleet/alice')).toBe(false);
    const ghArgs = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    expect(ghArgs).toEqual(['pr', 'create', '--head', 'feat/feature', '--base', 'main', '--fill']);
  });

  it('derives the name from the first commit subject on the branch', async () => {
    await addOrigin();
    stubGh();
    await spawn('alice', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'alice'),
      'limits.txt',
      'l\n',
      'fix(rate-limit): scope anonymous quota to browser sessions',
    );
    await commitFile(worktreePath(repo.root, 'alice'), 'limits.txt', 'l2\n', 'chore: tidy');

    const result = await pr('alice', { cwd: repo.root });

    expect(result.publicBranch).toBe('fix/rate-limit-scope-anonymous-quota-to-browser');
    expect(await branchOnOrigin('fix/rate-limit-scope-anonymous-quota-to-browser')).toBe(true);
  });

  it('--head overrides the derived name', async () => {
    await addOrigin();
    const argsFile = stubGh();
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    const result = await pr('alice', { head: 'my-own-name', cwd: repo.root });

    expect(result.publicBranch).toBe('my-own-name');
    expect(await branchOnOrigin('my-own-name')).toBe(true);
    expect(await branchOnOrigin('feat/feature')).toBe(false);
    const ghArgs = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    expect(ghArgs).toContain('my-own-name');
  });

  it('rejects an invalid --head branch name', async () => {
    await addOrigin();
    stubGh();
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    await expect(pr('alice', { head: 'bad name', cwd: repo.root })).rejects.toThrow(/Invalid --head/);
    await expect(pr('alice', { head: 'a..b', cwd: repo.root })).rejects.toThrow(/Invalid --head/);
    expect(await branchesOnOrigin()).toEqual([]);
  });

  it('records the public branch and reuses it on re-runs', async () => {
    await addOrigin();
    stubGh();
    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'feature.txt', 'f\n', 'feat: feature');

    await pr('alice', { cwd: repo.root });
    expect(readState(repo.root).agents['alice']?.prBranch).toBe('feat/feature');

    // More work lands, with a different subject; the published name must not drift.
    await commitFile(worktreePath(repo.root, 'alice'), 'other.txt', 'o\n', 'refactor: rename');
    const second = await pr('alice', { cwd: repo.root });

    expect(second.publicBranch).toBe('feat/feature');
    expect(await branchesOnOrigin()).toEqual(['feat/feature']);
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
      '--head', 'feat/feature',
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

    // The manual fallback it prints must also use the safe public name.
    await expect(pr('alice', { cwd: repo.root })).rejects.toThrow(
      /git push -u origin fleet\/alice:refs\/heads\/feat\/feature/,
    );
    expect(await branchesOnOrigin()).toEqual([]);
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

describe('derivePublicBranch (pure)', () => {
  const TIP = '0123456789abcdef';

  it('keeps the conventional type and slugs scope plus description', () => {
    expect(derivePublicBranch('fix(rate-limit): scope anonymous quota to browser sessions', TIP)).toBe(
      'fix/rate-limit-scope-anonymous-quota-to-browser',
    );
    expect(derivePublicBranch('feat: feature', TIP)).toBe('feat/feature');
  });

  it('slugs a non-conventional subject as-is', () => {
    expect(derivePublicBranch('Update README badges', TIP)).toBe('update-readme-badges');
  });

  it('falls back to pr-<short-tip> when there is no usable subject', () => {
    expect(derivePublicBranch(undefined, TIP)).toBe('pr-0123456');
    expect(derivePublicBranch('   ', TIP)).toBe('pr-0123456');
    expect(derivePublicBranch('???', TIP)).toBe('pr-0123456');
  });

  it('never emits an agent-tool name for ordinary agent names', () => {
    for (const subject of ['feat: add parser', 'fix(api): timeout']) {
      const derived = derivePublicBranch(subject, TIP);
      expect(derived).not.toMatch(/claude|codex|cursor|fleet\//);
    }
  });
});
