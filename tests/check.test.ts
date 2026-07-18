import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { check } from '../src/commands/check.js';
import { spawn } from '../src/commands/spawn.js';
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

describe('fleet check', () => {
  it('flags a file committed by two different agents', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: alice edit');
    await commitFile(worktreePath(repo.root, 'bob'), 'src.txt', 'bob\n', 'feat: bob edit');

    const result = await check({ cwd: repo.root });

    expect(result.agentsChecked).toBe(2);
    // Both agents rewrite the whole two-line fixture: a genuine predicted conflict.
    expect(result.collisions).toEqual([
      { file: 'src.txt', agents: ['alice', 'bob'], verdict: 'conflicts' },
    ]);
  });

  it('counts uncommitted edits as collision risk', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: alice edit');
    // bob touches the same file but has not committed yet — still a risk.
    writeFileSync(path.join(worktreePath(repo.root, 'bob'), 'src.txt'), 'bob wip\n');

    const result = await check({ cwd: repo.root });
    expect(result.collisions).toEqual([
      { file: 'src.txt', agents: ['alice', 'bob'], verdict: 'uncommitted' },
    ]);
  });

  it('reports no collisions when agents touch disjoint files', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'a.txt', 'a\n', 'feat: a');
    await commitFile(worktreePath(repo.root, 'bob'), 'b.txt', 'b\n', 'feat: b');

    const result = await check({ cwd: repo.root });
    expect(result.collisions).toEqual([]);
  });

  it('skips the check when fewer than two agents exist', async () => {
    await spawn('alice', { cwd: repo.root });
    const result = await check({ cwd: repo.root });
    expect(result).toEqual({ collisions: [], prediction: 'merge-tree', agentsChecked: 1 });
  });

  it('--json prints the result as parseable JSON', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: alice edit');
    await commitFile(worktreePath(repo.root, 'bob'), 'src.txt', 'bob\n', 'feat: bob edit');

    const result = await check({ json: true, cwd: repo.root });

    const printed = JSON.parse(
      vi.mocked(console.log).mock.calls.at(-1)?.[0] as string,
    ) as typeof result;
    expect(printed).toEqual(result);
    expect(printed.collisions).toEqual([
      { file: 'src.txt', agents: ['alice', 'bob'], verdict: 'conflicts' },
    ]);
  });
});

describe('merge-tree verdicts', () => {
  const EIGHT_LINES = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';

  it('classifies a same-line overlap as a conflicts collision', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: a');
    await commitFile(worktreePath(repo.root, 'bob'), 'src.txt', 'bob\n', 'feat: b');

    const result = await check({ cwd: repo.root });

    expect(result.prediction).toBe('merge-tree');
    expect(result.collisions).toEqual([
      { file: 'src.txt', agents: ['alice', 'bob'], verdict: 'conflicts' },
    ]);
    expect(result.cleanMerges).toEqual([]);
  });

  it('demotes a cleanly merging overlap to cleanMerges (no collision)', async () => {
    await commitFile(repo.root, 'many.txt', EIGHT_LINES, 'chore: seed');
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'alice'),
      'many.txt',
      EIGHT_LINES.replace('l1\n', 'l1 alice\n'),
      'feat: top',
    );
    await commitFile(
      worktreePath(repo.root, 'bob'),
      'many.txt',
      EIGHT_LINES.replace('l8\n', 'l8 bob\n'),
      'feat: bottom',
    );

    const result = await check({ cwd: repo.root });

    expect(result.collisions).toEqual([]);
    expect(result.cleanMerges).toEqual([{ file: 'many.txt', agents: ['alice', 'bob'] }]);
  });

  it('keeps overlaps with uncommitted edits blocking (fail closed)', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: a');
    writeFileSync(path.join(worktreePath(repo.root, 'bob'), 'src.txt'), 'bob uncommitted\n');

    const result = await check({ cwd: repo.root });

    expect(result.collisions).toEqual([
      { file: 'src.txt', agents: ['alice', 'bob'], verdict: 'uncommitted' },
    ]);
  });

  it('--files-only restores v0.1 semantics', async () => {
    await commitFile(repo.root, 'many.txt', EIGHT_LINES, 'chore: seed');
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'alice'),
      'many.txt',
      EIGHT_LINES.replace('l1\n', 'l1 alice\n'),
      'feat: top',
    );
    await commitFile(
      worktreePath(repo.root, 'bob'),
      'many.txt',
      EIGHT_LINES.replace('l8\n', 'l8 bob\n'),
      'feat: bottom',
    );

    const result = await check({ filesOnly: true, cwd: repo.root });

    expect(result.prediction).toBe('files');
    expect(result.collisions).toEqual([{ file: 'many.txt', agents: ['alice', 'bob'] }]);
    expect(result.cleanMerges).toBeUndefined();
  });

  it('--lines combines: verdict plus line overlap on the same collision', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src.txt', 'alice\n', 'feat: a');
    await commitFile(worktreePath(repo.root, 'bob'), 'src.txt', 'bob\n', 'feat: b');

    const result = await check({ lines: true, cwd: repo.root });

    expect(result.prediction).toBe('merge-tree');
    expect(result.collisions).toHaveLength(1);
    const [collision] = result.collisions;
    expect(collision).toMatchObject({ file: 'src.txt', verdict: 'conflicts' });
    expect(collision?.overlap).toBeDefined();
  });
});

// The line-refinement layer owns the `disjoint` bucket, which only exists when
// merge simulation is off — on capable git a cleanly-merging overlap is decided
// by its verdict and lands in `cleanMerges` instead. These tests therefore pin
// the files-only path explicitly; the combined path is covered by the
// '--lines combines' case in 'merge-tree verdicts' above.
describe('fleet check --lines (files-only mode)', () => {
  const numberedLines = (): string[] => Array.from({ length: 12 }, (_, i) => `line${i + 1}`);

  async function seedNumberedFile(): Promise<void> {
    await commitFile(repo.root, 'big.txt', `${numberedLines().join('\n')}\n`, 'feat: fixture');
  }

  function editLine(agent: string, lineNo: number): string {
    const lines = numberedLines();
    lines[lineNo - 1] = `edited by ${agent}`;
    return `${lines.join('\n')}\n`;
  }

  it('treats same-file edits on disjoint lines as non-collisions', async () => {
    await seedNumberedFile();
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'big.txt', editLine('alice', 2), 'feat: alice edit');
    await commitFile(worktreePath(repo.root, 'bob'), 'big.txt', editLine('bob', 10), 'feat: bob edit');

    const result = await check({ lines: true, filesOnly: true, cwd: repo.root });

    expect(result.collisions).toEqual([]);
    expect(result.disjoint).toEqual([{ file: 'big.txt', agents: ['alice', 'bob'] }]);
  });

  it('flags overlapping edits with their line ranges, including uncommitted ones', async () => {
    await seedNumberedFile();
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'big.txt', editLine('alice', 5), 'feat: alice edit');
    // bob's overlapping edit is uncommitted — still measured from the merge base.
    writeFileSync(path.join(worktreePath(repo.root, 'bob'), 'big.txt'), editLine('bob', 5));

    const result = await check({ lines: true, filesOnly: true, cwd: repo.root });

    expect(result.collisions).toEqual([
      { file: 'big.txt', agents: ['alice', 'bob'], overlap: '5' },
    ]);
    expect(result.disjoint).toEqual([]);
  });

  it('marks files without line info (untracked on both sides) as whole-file', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    writeFileSync(path.join(worktreePath(repo.root, 'alice'), 'new.txt'), 'a\n');
    writeFileSync(path.join(worktreePath(repo.root, 'bob'), 'new.txt'), 'b\n');

    const result = await check({ lines: true, filesOnly: true, cwd: repo.root });

    expect(result.collisions).toEqual([
      { file: 'new.txt', agents: ['alice', 'bob'], overlap: 'whole-file' },
    ]);
  });
});
