import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import tmp from 'tmp';

tmp.setGracefulCleanup();

export interface TempRepo {
  root: string;
  git: SimpleGit;
  cleanup: () => void;
}

/**
 * Create a real, throwaway git repository with one commit on `main`.
 * Every test runs against one of these — never against mocks and never
 * against the developer's actual repositories.
 */
export async function makeTempRepo(): Promise<TempRepo> {
  const dir = tmp.dirSync({ unsafeCleanup: true, prefix: 'fleet-test-' });
  // Native realpath up front so paths derived from git output compare cleanly.
  // Unlike the JS implementation, it also expands Windows 8.3 short names
  // (C:\Users\RUNNER~1\...), which is how CI runners spell %TEMP%.
  const root = realpathSync.native(dir.name);
  const git = simpleGit({ baseDir: root });
  await git.raw(['init', '-b', 'main']);
  await git.addConfig('user.name', 'Fleet Test');
  await git.addConfig('user.email', 'fleet-test@example.com');
  await git.addConfig('commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  writeFileSync(path.join(root, 'src.txt'), 'line1\nline2\n');
  await git.add(['.']);
  await git.commit('chore: initial commit');
  return {
    root,
    git,
    cleanup: () => {
      try {
        dir.removeCallback();
      } catch {
        // Windows can hold transient locks on .git files; graceful cleanup
        // will retry at process exit.
      }
    },
  };
}

/** Write (creating parent dirs) and commit a file inside a repo or worktree. */
export async function commitFile(
  repoDir: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  const full = path.join(repoDir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  const git = simpleGit({ baseDir: repoDir });
  await git.add([file]);
  await git.commit(message);
}

/** Absolute path of an agent's worktree inside a temp repo. */
export function worktreePath(repoRoot: string, agentName: string): string {
  return path.join(repoRoot, '.fleet', 'worktrees', agentName);
}

// Enough environment for git to run; nothing more. simple-git's unsafe-env
// guard rejects a full process.env spread whenever the session sets EDITOR,
// GIT_ASKPASS, PAGER, … (common in CI and agent harnesses).
const CHILD_ENV_KEYS = new Set([
  'PATH',
  'SYSTEMROOT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
]);

/** Write and commit a file with explicit author/committer dates (staleness tests). */
export async function commitFileAt(
  repoDir: string,
  file: string,
  content: string,
  message: string,
  isoDate: string,
): Promise<void> {
  writeFileSync(path.join(repoDir, file), content);
  const env: Record<string, string> = {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && CHILD_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
  }
  const git = simpleGit({ baseDir: repoDir }).env(env);
  await git.add([file]);
  await git.commit(message);
}
