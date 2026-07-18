import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { atLeast, MERGE_TREE_MIN, parseGitVersion, supportsMergeTree } from '../src/lib/git.js';

describe('parseGitVersion', () => {
  it('parses plain and platform-suffixed versions', () => {
    expect(parseGitVersion('git version 2.38.0')).toEqual({ major: 2, minor: 38 });
    expect(parseGitVersion('git version 2.45.1.windows.1')).toEqual({ major: 2, minor: 45 });
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual({ major: 2, minor: 39 });
  });

  it('returns null for unrecognizable output', () => {
    expect(parseGitVersion('')).toBeNull();
    expect(parseGitVersion('not git at all')).toBeNull();
  });
});

describe('atLeast', () => {
  it('compares against the merge-tree floor', () => {
    expect(atLeast({ major: 2, minor: 38 }, MERGE_TREE_MIN)).toBe(true);
    expect(atLeast({ major: 2, minor: 37 }, MERGE_TREE_MIN)).toBe(false);
    expect(atLeast({ major: 3, minor: 0 }, MERGE_TREE_MIN)).toBe(true);
    expect(atLeast({ major: 2, minor: 45 }, MERGE_TREE_MIN)).toBe(true);
  });
});

describe('supportsMergeTree', () => {
  it('answers for the locally installed git without throwing', async () => {
    // CI runners and dev machines all have modern git; the assertion that
    // matters everywhere is "boolean, no crash".
    await expect(supportsMergeTree(simpleGit())).resolves.toBeTypeOf('boolean');
  });
});
