import { parseTranscript } from '@core/parse';
import { redactProject } from '@core/privacy';
import type { SessionStat, UnreadableFile } from '@core/types';

/**
 * Reads transcripts the user selects in the browser.
 *
 * The CLI's scanner walks the filesystem; this one walks a FileList from a
 * directory picker. Both hand the text to the SAME `parseTranscript`, so the
 * numbers cannot diverge between the terminal and the web app.
 *
 * Nothing here uploads anything. Files are read with FileReader, parsed in the
 * tab, and discarded. Only the aggregate leaves the browser, and only after the
 * user presses save.
 */

export interface ScanProgress {
  done: number;
  total: number;
  current: string;
}

/**
 * Derive the project label and subagent flag from a picked file's relative path.
 *
 * A directory pick rooted at `projects/` yields paths like
 * `projects/<project>/<id>.jsonl`, matching the CLI's depth convention. When
 * the browser gives no relative path (a plain multi-file pick), everything is
 * treated as a top-level session in an unknown project.
 */
export function describePath(relPath: string): {
  project: string;
  id: string;
  isSubagent: boolean;
} {
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] ?? 'session.jsonl';
  const id = fileName.replace(/\.jsonl$/i, '');

  // Drop the picker's own root folder so depth matches the CLI, where the
  // projects root itself is not part of the relative path.
  const below = parts.slice(1);
  const project = below.length > 1 ? (below[0] ?? 'unknown') : 'unknown';
  const isSubagent = below.length > 2;

  return { project, id, isSubagent };
}

// Re-exported so callers here keep importing it from the reader they use. The
// definition lives in the core because the CLI produces the same thing.
export type { UnreadableFile };

export interface ScanResult {
  stats: SessionStat[];
  /** Files that were read but contained no parseable usage. */
  emptyFiles: number;
  /**
   * Files that could not be read or parsed at all. These are NOT in `stats`,
   * so any total built from this result excludes them.
   */
  unreadable: UnreadableFile[];
  /** Transcripts offered to the scanner: `stats.length + unreadable.length`. */
  filesSeen: number;
}

/**
 * How long to wait before the single re-read.
 *
 * Long enough for an in-flight append to land, short enough that a directory
 * where every file fails does not add a visible delay per file.
 */
const RETRY_DELAY_MS = 60;

/**
 * Read a picked file, retrying once.
 *
 * The picker captures a handle at selection time and the browser validates it
 * at read time. Claude Code rewrites its `.jsonl` files while sessions run, so
 * a handle can go stale between the two and `.text()` rejects with
 * `NotReadableError`. Anyone measuring their usage has just been using Claude
 * Code, which makes that the normal case rather than an edge one. A single
 * re-read usually lands after the write has settled.
 */
async function readWithRetry(file: File): Promise<string> {
  try {
    return await file.text();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return file.text();
  }
}

/** Turn a thrown value into something worth showing a user. */
function describeFailure(err: unknown): string {
  // DOMException carries the useful part in `name`; its `message` is often empty.
  if (err instanceof Error && err.name === 'NotReadableError') {
    return 'changed on disk while it was being read';
  }
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (err instanceof Error) return err.name;
  return 'unknown read error';
}

export async function scanFiles(
  files: readonly File[],
  home: string,
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanResult> {
  const transcripts = files.filter((f) => f.name.toLowerCase().endsWith('.jsonl'));
  const stats: SessionStat[] = [];
  const unreadable: UnreadableFile[] = [];
  let emptyFiles = 0;

  for (let i = 0; i < transcripts.length; i += 1) {
    const file = transcripts[i];
    if (!file) continue;

    // webkitRelativePath is populated by a directory pick and empty otherwise.
    const relPath = file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name;
    const { project, id, isSubagent } = describePath(relPath);

    onProgress?.({ done: i, total: transcripts.length, current: id });

    // Scoped to this file on purpose. Wrapping the whole loop instead means one
    // file a live session happened to be writing discards every other file's
    // work and the run reports nothing, which is what used to happen.
    try {
      const text = await readWithRetry(file);
      const stat = parseTranscript(text, {
        id,
        // Redact before the value can ever reach state, let alone the network.
        project: redactProject(project, home),
        isSubagent,
        bytes: file.size,
      });

      if (stat.turns === 0) emptyFiles += 1;
      stats.push(stat);
    } catch (err) {
      unreadable.push({ path: relPath, reason: describeFailure(err) });
    }

    // Yield to the event loop so a large pick does not freeze the tab.
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.({ done: transcripts.length, total: transcripts.length, current: '' });
  return { stats, emptyFiles, unreadable, filesSeen: transcripts.length };
}
