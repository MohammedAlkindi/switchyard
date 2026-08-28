import fs from 'node:fs';
import path from 'node:path';

import { parseTranscript } from './parse.js';
import type { SessionStat } from './types.js';

/**
 * Filesystem side of transcript reading.
 *
 * This module owns everything that touches disk. The actual parsing lives in
 * `parse.ts`, which is Node-free so the browser can run the identical code —
 * importing `node:fs` from a shared module would break the web bundle.
 */

/** Recursively collect *.jsonl paths under a root. */
export function listTranscripts(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listTranscripts(full, out);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * Read one transcript from disk and parse it.
 *
 * @param file      Absolute path to the .jsonl transcript.
 * @param relDepth  Path depth below the projects root. Main sessions live at
 *                  `<project>/<id>.jsonl` (depth 2); subagents nest deeper.
 */
export function scanFile(
  file: string,
  relDepth: number,
  project: string,
  sessionDepth = 2,
): SessionStat {
  const id = path.basename(file, '.jsonl');
  const isSubagent = relDepth > sessionDepth;

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return parseTranscript('', { id, project, isSubagent, bytes: 0, file });
  }

  return parseTranscript(text, {
    id,
    project,
    isSubagent,
    bytes: Buffer.byteLength(text, 'utf8'),
    file,
  });
}

/** What shape of directory `--root` turned out to be pointing at. */
export interface CorpusLayout {
  /** Relative path depth at which main-session transcripts sit. */
  sessionDepth: number;
  /**
   * True when `--root` names one project directory rather than the projects
   * root. Callers should say so: the numbers are right for that project, but a
   * user who believes they measured everything has measured one slug.
   */
  singleProject: boolean;
  /** Transcripts found. Zero means the shape could not be determined. */
  transcripts: number;
}

/**
 * Work out where session transcripts sit relative to `root`.
 *
 * At `~/.claude/projects` the layout is `<project>/<id>.jsonl`, so sessions are
 * at depth 2 and anything deeper is a subagent. Pointing `--root` one level in,
 * at a single project, shifts every file up by one — and the old fixed depth
 * then misreported it twice over without erroring: every project resolved to
 * `'unknown'`, and subagent transcripts landed at depth 2 and were counted as
 * sessions, inflating sessionCount. Deriving the depth from the corpus makes
 * both cases correct instead of making one of them silently wrong.
 */
export function detectLayout(root: string, files: readonly string[]): CorpusLayout {
  let shallowest = Number.POSITIVE_INFINITY;
  for (const file of files) {
    shallowest = Math.min(shallowest, path.relative(root, file).split(path.sep).length);
  }
  const sessionDepth = Number.isFinite(shallowest) ? shallowest : 2;
  return { sessionDepth, singleProject: sessionDepth < 2, transcripts: files.length };
}

/** Scan every transcript under `root`, with the layout that was inferred. */
export function scanCorpus(root: string): { stats: SessionStat[]; layout: CorpusLayout } {
  const files = listTranscripts(root);
  const layout = detectLayout(root, files);
  const stats: SessionStat[] = [];

  for (const file of files) {
    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    // The project is the segment one level above the session file, wherever that
    // turned out to be: index 0 at a projects root, index 1 if --root was aimed a
    // level higher. A subagent nests deeper but belongs to the same project, so
    // the index is taken from the layout rather than from this file's own depth.
    // With a single project directory there is no such segment at all and the
    // directory's own name is the slug, which beats labelling everything
    // 'unknown' — what the previous fixed depth did to every file in that case.
    const project = layout.singleProject
      ? path.basename(root) || 'unknown'
      : (parts[layout.sessionDepth - 2] ?? 'unknown');
    stats.push(scanFile(file, parts.length, project, layout.sessionDepth));
  }

  return { stats, layout };
}

/** Scan every transcript under `root`. */
export function scanAll(root: string): SessionStat[] {
  return scanCorpus(root).stats;
}

export { parseTranscript } from './parse.js';
export type { ParseOptions } from './parse.js';
