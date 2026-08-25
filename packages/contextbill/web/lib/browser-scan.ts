import { parseTranscript } from '@core/parse';
import { redactProject } from '@core/privacy';
import type { SessionStat } from '@core/types';

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

export interface ScanResult {
  stats: SessionStat[];
  /** Files that were picked but contained no parseable usage. */
  emptyFiles: number;
}

export async function scanFiles(
  files: readonly File[],
  home: string,
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanResult> {
  const transcripts = files.filter((f) => f.name.toLowerCase().endsWith('.jsonl'));
  const stats: SessionStat[] = [];
  let emptyFiles = 0;

  for (let i = 0; i < transcripts.length; i += 1) {
    const file = transcripts[i];
    if (!file) continue;

    // webkitRelativePath is populated by a directory pick and empty otherwise.
    const relPath = file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name;
    const { project, id, isSubagent } = describePath(relPath);

    onProgress?.({ done: i, total: transcripts.length, current: id });

    const text = await file.text();
    const stat = parseTranscript(text, {
      id,
      // Redact before the value can ever reach state, let alone the network.
      project: redactProject(project, home),
      isSubagent,
      bytes: file.size,
    });

    if (stat.turns === 0) emptyFiles += 1;
    stats.push(stat);

    // Yield to the event loop so a large pick does not freeze the tab.
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  onProgress?.({ done: transcripts.length, total: transcripts.length, current: '' });
  return { stats, emptyFiles };
}
