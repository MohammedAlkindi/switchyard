/**
 * Line-range utilities for `fleet check --lines`: parse `git diff -U0` output
 * into per-file ranges and intersect them across agents.
 *
 * All ranges are 1-indexed, inclusive, and expressed in *old-side* (merge-base)
 * coordinates — the only coordinate system two agents' diffs share when both
 * branched from the same base commit. When bases have diverged the ranges are
 * a best-effort heuristic, which is why line-level checking is opt-in.
 */

export interface LineRange {
  start: number;
  end: number;
}

/** Per-file edited ranges; 'whole' when line info is unknowable (binary, untracked, …). */
export type FileRanges = LineRange[] | 'whole';

/**
 * Parse unified diff output (`git diff -U0`) into a map of file path (new
 * side; old side for deletions) to edited old-side line ranges. A pure
 * insertion (`-N,0`) is widened to [N, N+1] so that two agents inserting at
 * the same spot still count as overlapping.
 */
export function parseUnifiedDiff(text: string): Map<string, FileRanges> {
  const result = new Map<string, FileRanges>();
  let current: string | null = null;
  let aPath: string | null = null;
  let headerPath: string | null = null;

  const pathFrom = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed === '/dev/null') return null;
    return trimmed.replace(/^[ab]\//, '');
  };

  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(.*) b\//.exec(line);
    if (header) {
      current = null;
      aPath = null;
      headerPath = header[1] ?? null;
      continue;
    }
    if (line.startsWith('--- ')) {
      aPath = pathFrom(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = pathFrom(line.slice(4)) ?? aPath;
      if (current && !result.has(current)) result.set(current, []);
      continue;
    }
    if (line.startsWith('Binary files ')) {
      const file = current ?? headerPath;
      if (file) result.set(file, 'whole');
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (hunk && current) {
      const entry = result.get(current);
      if (!entry || entry === 'whole') continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      entry.push(count === 0 ? { start, end: start + 1 } : { start, end: start + count - 1 });
    }
  }
  return result;
}

/** Sort and merge overlapping/adjacent ranges into a minimal list. */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Intersect the edited ranges of several agents for one file.
 * Returns 'whole' when any agent's line info is unknowable, otherwise the
 * (possibly empty) union of pairwise intersections — empty means the agents
 * edited disjoint lines.
 */
export function rangesOverlap(entries: FileRanges[]): FileRanges {
  if (entries.some((e) => e === 'whole')) return 'whole';
  const lists = entries as LineRange[][];
  const hits: LineRange[] = [];
  for (let i = 0; i < lists.length; i += 1) {
    for (let j = i + 1; j < lists.length; j += 1) {
      for (const a of lists[i] ?? []) {
        for (const b of lists[j] ?? []) {
          const start = Math.max(a.start, b.start);
          const end = Math.min(a.end, b.end);
          if (start <= end) hits.push({ start, end });
        }
      }
    }
  }
  return mergeRanges(hits);
}

/** "3-7, 12" style rendering for a range list. */
export function formatRanges(ranges: LineRange[]): string {
  return ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(', ');
}
