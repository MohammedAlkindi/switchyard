import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../src/commands/init.js';
import { readConfig } from '../src/lib/config.js';
import {
  AGENTS_BLOCK,
  BLOCK_BEGIN,
  BLOCK_END,
  SKILL_INSTALL_PATH,
  readPackagedSkill,
  upsertMarkedBlock,
} from '../src/lib/protocol.js';
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

function read(relative: string): string {
  return readFileSync(path.join(repo.root, ...relative.split('/')), 'utf8');
}

function write(relative: string, content: string): void {
  writeFileSync(path.join(repo.root, ...relative.split('/')), content, 'utf8');
}

function actionFor(steps: { path: string; action: string }[], file: string): string | undefined {
  return steps.find((s) => s.path === file)?.action;
}

describe('fleet init', () => {
  it('creates the config, the skill, and the AGENTS.md block', async () => {
    const result = await init({ cwd: repo.root });

    expect(actionFor(result.steps, '.fleetrc.json')).toBe('created');
    expect(actionFor(result.steps, SKILL_INSTALL_PATH)).toBe('created');
    expect(actionFor(result.steps, 'AGENTS.md')).toBe('created');

    // The config must survive its own validator, not merely be valid JSON.
    expect(readConfig(repo.root)).toEqual({});
    expect(read(SKILL_INSTALL_PATH)).toBe(readPackagedSkill());
    expect(read('AGENTS.md')).toContain(BLOCK_BEGIN);
    expect(read('AGENTS.md')).toContain('fleet check');
  });

  it('adds .fleet/ to .git/info/exclude without a spawn', async () => {
    const first = await init({ cwd: repo.root });
    expect(read('.git/info/exclude')).toContain('.fleet/');
    // Reports what it actually did: added on the first run, not on the second.
    expect(actionFor(first.steps, '.git/info/exclude')).toBe('updated');

    const second = await init({ cwd: repo.root });
    expect(actionFor(second.steps, '.git/info/exclude')).toBe('unchanged');
  });

  it('is idempotent: a second run changes nothing', async () => {
    await init({ cwd: repo.root });
    const before = read('AGENTS.md');

    const second = await init({ cwd: repo.root });

    expect(read('AGENTS.md')).toBe(before);
    expect(actionFor(second.steps, SKILL_INSTALL_PATH)).toBe('unchanged');
    expect(actionFor(second.steps, 'AGENTS.md')).toBe('unchanged');
    // One block, not two — the marker replacement is what prevents duplication.
    expect(before.split(BLOCK_BEGIN)).toHaveLength(2);
  });

  it('keeps an existing .fleetrc.json unless --force is passed', async () => {
    write('.fleetrc.json', '{ "defaultBase": "dev" }');

    const kept = await init({ cwd: repo.root });
    expect(actionFor(kept.steps, '.fleetrc.json')).toBe('kept');
    expect(readConfig(repo.root)).toEqual({ defaultBase: 'dev' });

    const forced = await init({ cwd: repo.root, force: true });
    expect(actionFor(forced.steps, '.fleetrc.json')).toBe('updated');
    expect(readConfig(repo.root)).toEqual({});
  });

  it('appends to an existing AGENTS.md, preserving the user content', async () => {
    write('AGENTS.md', '# Our agents\n\nDo not touch the vendored directory.\n');

    await init({ cwd: repo.root });

    const content = read('AGENTS.md');
    expect(content).toContain('# Our agents');
    expect(content).toContain('Do not touch the vendored directory.');
    expect(content).toContain(BLOCK_BEGIN);
    expect(content.indexOf('# Our agents')).toBeLessThan(content.indexOf(BLOCK_BEGIN));
  });

  it('replaces a stale block in place, leaving surrounding content alone', async () => {
    write(
      'AGENTS.md',
      `# Our agents\n\n${BLOCK_BEGIN}\nold and wrong\n${BLOCK_END}\n\n## House rules\n\nRun the linter.\n`,
    );

    const result = await init({ cwd: repo.root });

    const content = read('AGENTS.md');
    expect(actionFor(result.steps, 'AGENTS.md')).toBe('updated');
    expect(content).not.toContain('old and wrong');
    expect(content).toContain('# Our agents');
    expect(content).toContain('## House rules');
    expect(content).toContain('Run the linter.');
    expect(content.split(BLOCK_BEGIN)).toHaveLength(2);
  });

  it('refuses to guess when the markers are broken', async () => {
    write('AGENTS.md', `# Our agents\n\n${BLOCK_BEGIN}\nhalf a block, no end marker\n`);

    await expect(init({ cwd: repo.root })).rejects.toThrow(/broken markers/);
    // The user's file is left exactly as it was.
    expect(read('AGENTS.md')).toContain('half a block, no end marker');
  });

  it('refreshes the installed skill after a package upgrade', async () => {
    await init({ cwd: repo.root });
    write(SKILL_INSTALL_PATH, '# stale copy from an older version\n');

    const result = await init({ cwd: repo.root });

    expect(actionFor(result.steps, SKILL_INSTALL_PATH)).toBe('updated');
    expect(read(SKILL_INSTALL_PATH)).toBe(readPackagedSkill());
  });

  it('--json prints the result as parseable JSON and writes nothing else', async () => {
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    const result = await init({ cwd: repo.root, json: true });

    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] as string)).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it('never acquires the mutation lock beyond its own run', async () => {
    await init({ cwd: repo.root });
    expect(existsSync(path.join(repo.root, '.fleet', 'lock'))).toBe(false);
  });
});

describe('upsertMarkedBlock', () => {
  const block = `${BLOCK_BEGIN}\nnew\n${BLOCK_END}`;

  it('returns just the block for an empty file', () => {
    expect(upsertMarkedBlock('', block)).toBe(`${block}\n`);
    expect(upsertMarkedBlock('   \n\n', block)).toBe(`${block}\n`);
  });

  it('separates appended content with exactly one blank line', () => {
    expect(upsertMarkedBlock('# Title\n', block)).toBe(`# Title\n\n${block}\n`);
    expect(upsertMarkedBlock('# Title\n\n', block)).toBe(`# Title\n\n${block}\n`);
    expect(upsertMarkedBlock('# Title', block)).toBe(`# Title\n\n${block}\n`);
  });

  it('replaces only the marked region', () => {
    const existing = `before\n\n${BLOCK_BEGIN}\nold\n${BLOCK_END}\n\nafter\n`;
    expect(upsertMarkedBlock(existing, block)).toBe(`before\n\n${block}\n\nafter\n`);
  });

  it('throws on a half-present or inverted marker pair', () => {
    expect(() => upsertMarkedBlock(`${BLOCK_BEGIN}\nx\n`, block)).toThrow(/broken markers/);
    expect(() => upsertMarkedBlock(`${BLOCK_END}\nx\n`, block)).toThrow(/broken markers/);
    expect(() => upsertMarkedBlock(`${BLOCK_END}\n${BLOCK_BEGIN}\n`, block)).toThrow(
      /broken markers/,
    );
  });

  it('round-trips: applying the real block twice is a fixed point', () => {
    const once = upsertMarkedBlock('# Title\n', AGENTS_BLOCK);
    expect(upsertMarkedBlock(once, AGENTS_BLOCK)).toBe(once);
  });
});
