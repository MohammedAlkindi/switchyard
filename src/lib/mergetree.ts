import type { SimpleGit } from 'simple-git';

export interface MergePrediction {
  /** Paths git reports as conflicted when the two branches merge in memory. */
  conflictedFiles: string[];
}

/**
 * Real three-way merge of two branches in memory (`git merge-tree
 * --write-tree`, git >= 2.38): no worktree, index, or ref is touched. On
 * conflict, git exits 1 with the conflicted paths on stdout and an empty
 * stderr — which simple-git surfaces as normal output, not an error (the same
 * quirk `branchExists` documents), so both outcomes flow through the parser.
 *
 * -z framing, as observed from git itself:
 *   <tree-oid> NUL [<conflicted path> NUL]… NUL [<informational records> NUL]…
 * The conflicted-path list runs until the empty record that separates it from
 * the human-readable "Auto-merging"/"CONFLICT" messages; a clean merge emits
 * the OID and nothing else. Callers must gate on `supportsMergeTree` first.
 */
export async function predictMergeConflicts(
  git: SimpleGit,
  branchA: string,
  branchB: string,
): Promise<MergePrediction> {
  const out = await git.raw(['merge-tree', '--write-tree', '--name-only', '-z', branchA, branchB]);
  const records = out.split('\0');
  const conflictedFiles: string[] = [];
  for (const record of records.slice(1)) {
    if (record === '' || record === '\n') break;
    conflictedFiles.push(record);
  }
  conflictedFiles.sort((a, b) => a.localeCompare(b));
  return { conflictedFiles };
}
