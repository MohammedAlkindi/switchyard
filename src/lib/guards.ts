import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolveGuardedPath } from './config.js';

/**
 * Recorded state of a guarded path when a file cannot be read as a file at
 * all — absent, a directory, or unreadable. Distinct from any real digest, so
 * "it appeared since you spawned" is detectable rather than silently equal.
 */
export const ABSENT = 'absent';

/**
 * Content digest of one guarded path, or `ABSENT`.
 *
 * Guarded paths are shared files no repository tracks — `~/Github/CLAUDE.md`,
 * an OSS queue, a settings file. Git cannot see them, so a digest is the only
 * evidence available that one moved under an agent mid-session.
 */
export function hashGuardedPath(resolved: string): string {
  try {
    if (!statSync(resolved).isFile()) return ABSENT;
    return createHash('sha256').update(readFileSync(resolved)).digest('hex');
  } catch {
    return ABSENT;
  }
}

/** Digest every configured guarded path, keyed by the entry as written. */
export function snapshotGuarded(
  entries: string[] | undefined,
  repoRoot: string,
): Record<string, string> | undefined {
  if (!entries || entries.length === 0) return undefined;
  const snapshot: Record<string, string> = {};
  for (const entry of entries) {
    snapshot[entry] = hashGuardedPath(resolveGuardedPath(entry, repoRoot));
  }
  return snapshot;
}
