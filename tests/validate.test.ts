import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../src/commands/spawn.js';
import { validate, validateAll } from '../src/commands/validate.js';
import { gitAt, revParseOid } from '../src/lib/git.js';
import { readState } from '../src/lib/state.js';
import { commitFile, makeTempRepo, worktreePath } from './helpers.js';
import type { TempRepo } from './helpers.js';

/** Cross-platform commands with known exit codes (shell-run via runShell). */
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';

let repo: TempRepo;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  repo = await makeTempRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  repo.cleanup();
});

function configureValidate(command: string): void {
  writeFileSync(
    path.join(repo.root, '.fleetrc.json'),
    `${JSON.stringify({ validate: command }, null, 2)}\n`,
  );
}

describe('fleet validate', () => {
  it('runs the configured command and records a pass pinned to the branch tip', async () => {
    await spawn('alice', { cwd: repo.root });
    configureValidate(PASS);

    const result = await validate('alice', { cwd: repo.root });

    expect(result).toMatchObject({ name: 'alice', branch: 'fleet/alice', ok: true, exitCode: 0 });
    const record = readState(repo.root).agents['alice']?.validation;
    expect(record?.ok).toBe(true);
    expect(record?.command).toBe(PASS);
    expect(record?.commit).toBe(await revParseOid(gitAt(repo.root), 'fleet/alice'));
    expect(Date.parse(record?.at ?? '')).not.toBeNaN();
  });

  it('records a failing command as a result, not an error', async () => {
    await spawn('alice', { cwd: repo.root });
    configureValidate(FAIL);

    const result = await validate('alice', { cwd: repo.root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const record = readState(repo.root).agents['alice']?.validation;
    expect(record?.ok).toBe(false);
  });

  it('runs the command inside the agent worktree', async () => {
    await spawn('alice', { cwd: repo.root });
    configureValidate(`node -e "require('fs').writeFileSync('validate-ran.txt','1')"`);

    await validate('alice', { cwd: repo.root });

    expect(existsSync(path.join(worktreePath(repo.root, 'alice'), 'validate-ran.txt'))).toBe(true);
    expect(existsSync(path.join(repo.root, 'validate-ran.txt'))).toBe(false);
  });

  it('refuses a dirty worktree and records nothing', async () => {
    await spawn('alice', { cwd: repo.root });
    configureValidate(PASS);
    writeFileSync(path.join(worktreePath(repo.root, 'alice'), 'wip.txt'), 'w\n');

    await expect(validate('alice', { cwd: repo.root })).rejects.toThrow(/uncommitted change/);
    expect(readState(repo.root).agents['alice']?.validation).toBeUndefined();
  });

  it('errors when no validate command is configured', async () => {
    await spawn('alice', { cwd: repo.root });
    await expect(validate('alice', { cwd: repo.root })).rejects.toThrow(/No "validate" command/);
  });

  it('errors clearly for an unknown agent', async () => {
    configureValidate(PASS);
    await expect(validate('ghost', { cwd: repo.root })).rejects.toThrow(/No agent named "ghost"/);
  });

  it('--json prints the result as exactly one parseable payload', async () => {
    await spawn('alice', { cwd: repo.root });
    configureValidate(PASS);
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    const result = await validate('alice', { cwd: repo.root, json: true });

    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] as string)).toEqual(JSON.parse(JSON.stringify(result)));
  });
});

describe('fleet validate --all', () => {
  it('validates every agent, recording passes and failures alike', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    configureValidate(PASS);

    const result = await validateAll({ cwd: repo.root });

    expect(result.failed).toEqual([]);
    expect(result.validated.map((v) => v.name)).toEqual(['alice', 'bob']);
    expect(result.validated.every((v) => v.ok)).toBe(true);
    expect(readState(repo.root).agents['bob']?.validation?.ok).toBe(true);
  });

  it('continues past a dirty worktree and reports it as skipped', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    configureValidate(PASS);
    writeFileSync(path.join(worktreePath(repo.root, 'alice'), 'wip.txt'), 'w\n');

    const result = await validateAll({ cwd: repo.root });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ name: 'alice' });
    expect(result.failed[0]?.error).toMatch(/uncommitted change/);
    expect(result.validated).toHaveLength(1);
    expect(result.validated[0]).toMatchObject({ name: 'bob', ok: true });
    expect(readState(repo.root).agents['alice']?.validation).toBeUndefined();
  });

  it('errors up front when no validate command is configured', async () => {
    await spawn('alice', { cwd: repo.root });
    await expect(validateAll({ cwd: repo.root })).rejects.toThrow(/No "validate" command/);
  });

  it('returns empty results for an empty fleet', async () => {
    configureValidate(PASS);
    const result = await validateAll({ cwd: repo.root });
    expect(result).toEqual({ validated: [], failed: [] });
  });

  it('a new commit invalidates nothing by itself: the record stays pinned to the old tip', async () => {
    await spawn('alice', { cwd: repo.root });
    configureValidate(PASS);
    await validate('alice', { cwd: repo.root });
    const before = readState(repo.root).agents['alice']?.validation?.commit;

    await commitFile(worktreePath(repo.root, 'alice'), 'more.txt', 'm\n', 'feat: more work');

    // The record is untouched; staleness is derived at read time by comparing tips.
    const after = readState(repo.root).agents['alice']?.validation?.commit;
    expect(after).toBe(before);
    expect(after).not.toBe(await revParseOid(gitAt(repo.root), 'fleet/alice'));
  });
});
