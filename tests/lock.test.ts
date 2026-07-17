import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockPath, lockStatus, verifyOwnedLock, withLock } from '../src/lib/lock.js';
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

/** PID that existed and is now certainly dead: a `node -e ""` that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('could not spawn a probe process');
  return child.pid;
}

function writeForeignLock(pid: number): void {
  mkdirSync(path.join(repo.root, '.fleet'), { recursive: true });
  writeFileSync(
    lockPath(repo.root),
    JSON.stringify({ pid, command: 'spawn', startedAt: new Date().toISOString() }),
    'utf8',
  );
}

describe('withLock', () => {
  it('runs the function and releases the lock afterwards', async () => {
    const result = await withLock(repo.root, 'test', async () => {
      expect(existsSync(lockPath(repo.root))).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(lockPath(repo.root))).toBe(false);
  });

  it('is reentrant within one process (merge → autoClean → clean)', async () => {
    const result = await withLock(repo.root, 'outer', () =>
      withLock(repo.root, 'inner', async () => 'nested'),
    );
    expect(result).toBe('nested');
    expect(existsSync(lockPath(repo.root))).toBe(false);
  });

  it('releases the lock when the function throws', async () => {
    await expect(
      withLock(repo.root, 'test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath(repo.root))).toBe(false);
  });

  it('times out with a clear error while a live holder keeps the lock', async () => {
    writeForeignLock(process.pid); // our own pid: guaranteed alive, not "us" logically
    await expect(
      withLock(repo.root, 'test', async () => 'never', { timeoutMs: 300, retryMs: 50 }),
    ).rejects.toThrow(/Another fleet command holds the lock: spawn \(pid /);
    // The holder's lock was not stolen.
    expect(existsSync(lockPath(repo.root))).toBe(true);
  });

  it('takes over a lock whose holder is dead', async () => {
    writeForeignLock(deadPid());
    const result = await withLock(repo.root, 'test', async () => 'ok', {
      timeoutMs: 2_000,
      retryMs: 50,
    });
    expect(result).toBe('ok');
    expect(existsSync(lockPath(repo.root))).toBe(false);
  });

  it('treats an old unreadable lock file as stale', async () => {
    mkdirSync(path.join(repo.root, '.fleet'), { recursive: true });
    writeFileSync(lockPath(repo.root), 'not json{{{', 'utf8');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(repo.root), old, old); // definitely past the grace window
    const result = await withLock(repo.root, 'test', async () => 'ok', {
      timeoutMs: 2_000,
      retryMs: 50,
    });
    expect(result).toBe('ok');
  });

  it('leaves no leftover claim files behind after a stale takeover', async () => {
    writeForeignLock(deadPid());
    await withLock(repo.root, 'test', async () => 'ok', {
      timeoutMs: 2_000,
      retryMs: 50,
    });
    const leftover = readdirSync(path.join(repo.root, '.fleet')).filter((entry) =>
      entry.includes('.claim.'),
    );
    expect(leftover).toEqual([]);
  });

  it('treats a fresh unreadable lock file as live rather than stealing it', async () => {
    mkdirSync(path.join(repo.root, '.fleet'), { recursive: true });
    writeFileSync(lockPath(repo.root), 'not json{{{', 'utf8'); // no utimes backdating: mtime is now
    await expect(
      withLock(repo.root, 'test', async () => 'never', { timeoutMs: 300, retryMs: 50 }),
    ).rejects.toThrow(/Another fleet command holds the lock/);
  });
});

describe('lockStatus', () => {
  it('reports none / live / stale', () => {
    expect(lockStatus(repo.root).state).toBe('none');
    writeForeignLock(process.pid);
    expect(lockStatus(repo.root).state).toBe('live');
    writeForeignLock(deadPid());
    const s = lockStatus(repo.root);
    expect(s.state).toBe('stale');
    expect(s.info?.command).toBe('spawn');
  });
});

describe('verifyOwnedLock', () => {
  it('resolves true when the file already contains our pid', async () => {
    writeForeignLock(process.pid);
    await expect(verifyOwnedLock(lockPath(repo.root))).resolves.toBe(true);
  });

  it('resolves false immediately when the file contains a different pid', async () => {
    writeForeignLock(999_999);
    await expect(verifyOwnedLock(lockPath(repo.root))).resolves.toBe(false);
  });

  it('resolves true when the lock appears with our pid within the retry window', async () => {
    // Simulates the race this fixes: the file is transiently absent (a
    // concurrent claimant's inspect/restore dance) when verification starts,
    // then reappears with our pid before the retries are exhausted.
    setTimeout(() => writeForeignLock(process.pid), 20);
    await expect(verifyOwnedLock(lockPath(repo.root))).resolves.toBe(true);
  });

  it('resolves false when the file is permanently absent', async () => {
    await expect(verifyOwnedLock(lockPath(repo.root))).resolves.toBe(false);
  });
});
