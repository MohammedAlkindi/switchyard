import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fleetDir } from './state.js';
import type { AgentRecord } from './state.js';

/** Refs pinning the pre-merge commits so they survive branch deletion and GC. */
export const UNDO_HEAD_REF = 'refs/fleet/undo-head';
export const UNDO_BRANCH_REF = 'refs/fleet/undo-branch';

/** Everything `fleet undo` needs to roll back the last `fleet merge`. */
export interface UndoRecord {
  version: 1;
  agent: AgentRecord;
  /** Branch the merge went into. */
  into: string;
  headBefore: string;
  branchTip: string;
  headAfter: string;
  /** Whether merge's cleanup removed the worktree (and state entry). */
  cleaned: boolean;
  branchDeleted: boolean;
  mergedAt: string;
}

export function undoPath(repoRoot: string): string {
  return path.join(fleetDir(repoRoot), 'undo.json');
}

export function readUndoRecord(repoRoot: string): UndoRecord | null {
  const file = undoPath(repoRoot);
  if (!existsSync(file)) return null;
  try {
    // Strip a UTF-8 BOM, same as readState: Windows editors add one.
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as UndoRecord;
    if (parsed.version !== 1) return null;
    if (typeof parsed.headBefore !== 'string' || typeof parsed.agent?.name !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeUndoRecord(repoRoot: string, record: UndoRecord): void {
  const file = undoPath(repoRoot);
  const tmpFile = `${file}.tmp`;
  // Write-then-rename, same as state.json: a crash mid-write can't leave a
  // half-written record that `fleet undo` would then act on.
  writeFileSync(tmpFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmpFile, file);
}

export function clearUndoRecord(repoRoot: string): void {
  rmSync(undoPath(repoRoot), { force: true });
}
