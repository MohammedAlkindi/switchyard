import { spawn as spawnChild } from 'node:child_process';

/**
 * Run a shell command string in `cwd`, streaming its output to the terminal.
 * Resolves with the exit code — a failing command is an expected outcome for
 * callers (hooks, `fleet exec`), not an exception.
 */
export function runShell(command: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, { cwd, shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Run an executable with an argv array (no shell). Resolves with the exit
 * code, or -1 when the executable could not be started at all (e.g. not on
 * PATH) — callers turn that into a "not installed" message.
 */
export function runFile(
  file: string,
  args: string[],
  cwd: string,
  opts: { quiet?: boolean } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnChild(file, args, {
      cwd,
      shell: false,
      stdio: opts.quiet ? 'ignore' : 'inherit',
    });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// Tokens that survive both sh and cmd.exe without quoting.
const SAFE_TOKEN = /^[A-Za-z0-9_\-./:=@,+]+$/;

/**
 * Join argv tokens back into one shell command line, quoting anything that
 * needs it. A pragmatic heuristic that covers everyday commands on both sh
 * and cmd.exe — not a full shell-escaping engine; genuinely exotic quoting
 * belongs in a script file the command can call instead.
 */
export function shellJoin(tokens: string[]): string {
  return tokens
    .map((t) => (SAFE_TOKEN.test(t) ? t : `"${t.replace(/"/g, '\\"')}"`))
    .join(' ');
}
