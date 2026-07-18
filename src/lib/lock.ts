import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FleetError } from './errors.js';
import { dim } from './format.js';
import { fleetDir } from './state.js';

/** Metadata stored inside `.fleet/lock` for stale detection and diagnostics. */
export interface LockInfo {
  pid: number;
  command: string;
  startedAt: string;
}

export interface LockOptions {
  /** Total time to wait for a busy lock before failing. Test-only override. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. Test-only override. */
  retryMs?: number;
}

export interface LockStatus {
  state: 'none' | 'live' | 'stale';
  info: LockInfo | null;
  ageMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 100;
/**
 * An existing lock file whose JSON is unreadable is either mid-write (for
 * microseconds) or corrupt from a crash (forever). Past this age it is stale.
 */
const UNREADABLE_GRACE_MS = 2_000;
/** How hard `verifyOwnedLock` tries before concluding a lock is really gone. */
const VERIFY_ATTEMPTS = 5;
const VERIFY_RETRY_MS = 10;

/** Reentrancy depth: merge → autoClean → clean must not deadlock on itself. */
let holdDepth = 0;

export function lockPath(repoRoot: string): string {
  return path.join(fleetDir(repoRoot), 'lock');
}

/**
 * True when this process is inside a `withLock` body, i.e. the lock on disk is
 * the one we took. Callers that inspect the lock (`fleet doctor`) need this to
 * tell "someone else is mutating" from "I am the mutator" — a PID comparison
 * can't, since a foreign lock file may carry our PID after reuse, and `doctor
 * --fix` inspects the very lock it holds.
 */
export function holdingLock(): boolean {
  return holdDepth > 0;
}

/** True when a process with this PID is alive on this machine. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but not ours to signal. Anything else (ESRCH): gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read and parse a lock file's JSON without touching it. Returns `null` if
 * the file is missing, unreadable, or its content doesn't look like a lock
 * (factored out of `lockStatus` so the acquisition loop can inspect a
 * claimed-aside file the same way).
 */
function readLockInfoFrom(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number') {
      return {
        pid: parsed.pid,
        command: parsed.command ?? 'unknown',
        startedAt: parsed.startedAt ?? '',
      };
    }
    return null;
  } catch {
    return null; // unreadable — decided by age in lockStatus
  }
}

/** Inspect `.fleet/lock` without touching it — used by doctor and acquisition. */
export function lockStatus(repoRoot: string): LockStatus {
  const file = lockPath(repoRoot);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return { state: 'none', info: null, ageMs: 0 };
  }
  const ageMs = Math.max(0, Date.now() - mtimeMs);
  const info = readLockInfoFrom(file);
  if (info === null) {
    return { state: ageMs > UNREADABLE_GRACE_MS ? 'stale' : 'live', info: null, ageMs };
  }
  return { state: pidAlive(info.pid) ? 'live' : 'stale', info, ageMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the "lock is busy" error thrown when the acquisition deadline passes. */
function lockTimeoutError(timeoutMs: number, holder: LockInfo | null): FleetError {
  const holderDesc = holder
    ? `${holder.command} (pid ${holder.pid}, since ${holder.startedAt})`
    : 'an in-flight fleet command';
  return new FleetError(
    `Another fleet command holds the lock: ${holderDesc}.\n` +
      `Waited ${Math.round(timeoutMs / 1000)}s. If that process is gone, ` +
      '`fleet doctor --fix` removes dead locks; if it is stuck, stop it and re-run.',
  );
}

/**
 * Confirm the calling process still owns the lock at `file`, tolerating a
 * lock that transiently disappears: a concurrent stale-takeover's claim →
 * inspect → restore dance can rename this exact file away and back within
 * milliseconds, and a single read caught in that window would misread the
 * absence as having lost a lock we actually still hold. Reads up to
 * `VERIFY_ATTEMPTS` times, `VERIFY_RETRY_MS` apart: a matching pid means we
 * hold it; a *different* pid means someone else genuinely does (no point
 * retrying that); a missing/unreadable file retries, and if it is still
 * missing after all attempts, we conclude it is gone.
 *
 * Exported only so this decision logic is directly and deterministically
 * testable — it is not part of the CLI-facing surface.
 */
export async function verifyOwnedLock(file: string): Promise<boolean> {
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    const info = readLockInfoFrom(file);
    if (info !== null) return info.pid === process.pid;
    if (attempt < VERIFY_ATTEMPTS - 1) await sleep(VERIFY_RETRY_MS);
  }
  return false;
}

/**
 * Run `fn` while holding the repo's mutation lock (`.fleet/lock`), so
 * concurrent fleet processes can't interleave read→modify→write on
 * `state.json` or overlapping git mutations. Reentrant within one process;
 * in-process *parallel* mutators remain unsupported (unchanged from v0.1).
 */
export async function withLock<T>(
  repoRoot: string,
  command: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  if (holdDepth > 0) {
    holdDepth += 1;
    try {
      return await fn();
    } finally {
      holdDepth -= 1;
    }
  }

  const file = lockPath(repoRoot);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  const info: LockInfo = {
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
  };

  mkdirSync(fleetDir(repoRoot), { recursive: true });
  for (;;) {
    try {
      // Atomic exclusive create — the lock itself.
      writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const status = lockStatus(repoRoot);

      // Checked before any branch below (previously only the 'live' branch
      // checked it): otherwise a lock that keeps reporting 'none' or 'stale'
      // across attempts can make every branch `continue` without ever
      // reaching a deadline check, spinning past the timeout.
      if (Date.now() >= deadline) throw lockTimeoutError(timeoutMs, status.info);

      if (status.state === 'none') continue; // released between attempts

      if (status.state === 'live') {
        await sleep(retryMs);
        continue;
      }

      // status.state === 'stale': take over by claim-by-rename rather than
      // deleting outright. Delete-then-`wx`-create left a window where a
      // faster racer's freshly created live lock could be deleted by a
      // slower racer's `rmSync`; rename is atomic, so exactly one concurrent
      // claimant wins and a loser just gets ENOENT.
      //
      // Residual: without OS advisory locks (out of reach with zero new
      // dependencies), a claimant's inspect → restore dance below can make
      // some *other* process's freshly created lock transiently disappear
      // and reappear. That other process's verifyOwnedLock() (below)
      // absorbs this by re-reading before giving up rather than failing on
      // one null read, and every path out of the acquisition loop —
      // success, a genuine loss, or verify retries exhausted — still
      // checks the deadline before waiting again. What remains is a true
      // microsecond-scale interleaving that can briefly yield two holders;
      // that failure mode degrades to v0.1's unlocked behavior — the same
      // residual proper-lockfile documents.
      await sleep(Math.random() * 50); // jitter: de-synchronize concurrent stealers

      const claimPath = `${file}.claim.${process.pid}`;
      try {
        renameSync(file, claimPath);
      } catch (claimErr) {
        if ((claimErr as NodeJS.ErrnoException).code !== 'ENOENT') throw claimErr;
        // Lost the claim race — another process already claimed or released it.
        await sleep(retryMs);
        continue;
      }

      const claimed = readLockInfoFrom(claimPath);
      if (claimed !== null && pidAlive(claimed.pid)) {
        // Turned out live: we claimed a lock created in the window between
        // our lockStatus() read above and the rename landing. Put it back.
        try {
          renameSync(claimPath, file);
        } catch (restoreErr) {
          if ((restoreErr as NodeJS.ErrnoException).code !== 'EEXIST') throw restoreErr;
          // A third process created a new lock meanwhile; drop our copy.
          rmSync(claimPath, { force: true });
        }
        await sleep(retryMs);
        continue;
      }

      // Genuinely stale (dead pid, or unreadable — lockStatus already
      // applied the grace window before reporting 'stale'). Discard our
      // claimed copy and fall through to a normal `wx` create.
      console.log(
        dim(
          `removed stale fleet lock (pid ${claimed?.pid ?? 'unknown'}, ` +
            `${claimed?.command ?? 'crashed before recording'})`,
        ),
      );
      rmSync(claimPath, { force: true });
      continue;
    }

    // Confirm we still own what we just created. verifyOwnedLock() absorbs
    // the transient-absence window described in the 'stale' branch above
    // (a concurrent claimant's inspect → restore dance) instead of
    // concluding loss on a single read.
    if (await verifyOwnedLock(file)) break;

    // Genuinely lost it, or verify's retries were exhausted: like every
    // other `continue` in this loop, this one must not wait again without
    // first checking the deadline.
    if (Date.now() >= deadline) throw lockTimeoutError(timeoutMs, lockStatus(repoRoot).info);
    continue;
  }

  holdDepth = 1;
  try {
    return await fn();
  } finally {
    holdDepth = 0;
    // Delete only a lock we still own: after a (mistaken) takeover of a live
    // holder, a late finally must never clobber the successor's lock.
    const current = lockStatus(repoRoot).info;
    if (current === null || current.pid === process.pid) {
      rmSync(file, { force: true });
    }
  }
}
