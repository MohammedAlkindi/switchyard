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
export function scanFile(file: string, relDepth: number, project: string): SessionStat {
  const id = path.basename(file, '.jsonl');
  const isSubagent = relDepth > 2;

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

/** Scan every transcript under `root`. */
export function scanAll(root: string): SessionStat[] {
  const files = listTranscripts(root);
  const out: SessionStat[] = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    const project = parts.length > 1 ? (parts[0] ?? 'unknown') : 'unknown';
    out.push(scanFile(file, parts.length, project));
  }
  return out;
}

export { parseTranscript } from './parse.js';
export type { ParseOptions } from './parse.js';
