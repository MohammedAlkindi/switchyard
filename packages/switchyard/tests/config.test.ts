import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../src/commands/spawn.js';
import { readConfig } from '../src/lib/config.js';
import { readState } from '../src/lib/state.js';
import { commitFile, makeTempRepo } from './helpers.js';
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

function writeConfig(content: string): void {
  writeFileSync(path.join(repo.root, '.fleetrc.json'), content);
}

describe('.fleetrc.json', () => {
  it('reads a valid config', () => {
    writeConfig('{ "defaultBase": "dev", "watchInterval": 7, "autoClean": true }');
    expect(readConfig(repo.root)).toEqual({ defaultBase: 'dev', watchInterval: 7, autoClean: true });
  });

  it('falls back to empty defaults when the file is missing', () => {
    expect(readConfig(repo.root)).toEqual({});
  });

  it('tolerates a UTF-8 BOM (Windows editors add one)', () => {
    writeConfig('\uFEFF{ "watchInterval": 5 }');
    expect(readConfig(repo.root)).toEqual({ watchInterval: 5 });
  });

  it('errors clearly on malformed JSON', () => {
    writeConfig('{ "defaultBase": ');
    expect(() => readConfig(repo.root)).toThrow(/not valid JSON/);
  });

  it('errors clearly on wrong value types', () => {
    writeConfig('{ "watchInterval": "fast" }');
    expect(() => readConfig(repo.root)).toThrow(/positive number/);
  });

  it('errors clearly on unknown keys (typo protection)', () => {
    writeConfig('{ "watchInterva": 5 }');
    expect(() => readConfig(repo.root)).toThrow(/Unknown key "watchInterva"/);
  });

  it('accepts a $schema key without treating it as config', () => {
    writeConfig(
      '{ "$schema": "https://unpkg.com/@switchyardhq/switchyard/schema/fleetrc.schema.json", "watchInterval": 5 }',
    );
    expect(readConfig(repo.root)).toEqual({ watchInterval: 5 });
  });

  it('rejects a non-string $schema', () => {
    writeConfig('{ "$schema": 42 }');
    expect(() => readConfig(repo.root)).toThrow(/"\$schema".*must be a string/);
  });

  it('reads the provisioning and hook keys', () => {
    writeConfig('{ "copyOnSpawn": [".env"], "postSpawn": "npm ci", "preMerge": "npm test" }');
    expect(readConfig(repo.root)).toEqual({
      copyOnSpawn: ['.env'],
      postSpawn: 'npm ci',
      preMerge: 'npm test',
    });
  });

  it('rejects copyOnSpawn entries that escape the repository', () => {
    writeConfig('{ "copyOnSpawn": ["../evil"] }');
    expect(() => readConfig(repo.root)).toThrow(/inside the repository/);
  });

  it('rejects wrong types for the provisioning and hook keys', () => {
    writeConfig('{ "copyOnSpawn": ".env" }');
    expect(() => readConfig(repo.root)).toThrow(/array of non-empty path strings/);
    writeConfig('{ "preMerge": 42 }');
    expect(() => readConfig(repo.root)).toThrow(/non-empty command string/);
  });

  it('spawn precedence: --from flag > defaultBase > current branch', async () => {
    // Two extra branches to distinguish the sources.
    await repo.git.checkoutLocalBranch('dev');
    await commitFile(repo.root, 'dev.txt', 'd\n', 'feat: dev file');
    await repo.git.checkoutLocalBranch('flagged');
    await commitFile(repo.root, 'flagged.txt', 'f\n', 'feat: flagged file');
    await repo.git.checkout('main');

    // No config, no flag -> current branch (main).
    await spawn('from-current', { cwd: repo.root });
    expect(readState(repo.root).agents['from-current']?.baseBranch).toBe('main');

    // Config only -> defaultBase.
    writeConfig('{ "defaultBase": "dev" }');
    await spawn('from-config', { cwd: repo.root });
    expect(readState(repo.root).agents['from-config']?.baseBranch).toBe('dev');

    // Flag beats config.
    await spawn('from-flag', { from: 'flagged', cwd: repo.root });
    expect(readState(repo.root).agents['from-flag']?.baseBranch).toBe('flagged');
  });
});
