import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * npm installs a package's bin as a symlink on POSIX, so argv[1] is the link in
 * node_modules/.bin while import.meta.url is always the fully resolved file. An
 * entry-point guard that compares those two unresolved is therefore false for
 * every installed user: main() never runs, nothing is printed, and the process
 * still exits 0. A silent no-op is the worst shape this failure could take --
 * there is nothing for the user to search for.
 *
 * That is what 0.1.0 shipped. The rest of the suite imports parseArgs directly
 * and never spawns the CLI the way npm invokes it, which is exactly why nothing
 * caught it.
 *
 * Unlike its neighbours this file reads dist/, so it needs a build first. The
 * pretest script provides one.
 *
 * Windows never hit the original bug -- its .cmd and .ps1 shims pass the real
 * dist/cli.js path as argv[1], never the shim's own path -- but the guard is
 * shared code, so it is still worth testing there. A file symlink needs
 * Developer Mode or elevation on Windows; a junction does not, and it produces
 * the same condition the guard has to survive: an argv[1] whose real path is
 * somewhere else. Node ignores the type argument off Windows, where the same
 * call is an ordinary directory symlink.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'dist', 'cli.js');

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
) as { version: string };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextbill-entrypoint-'));
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function link(target: string, name: string, type: 'file' | 'junction'): string | null {
  const created = path.join(tmp, name);
  try {
    fs.symlinkSync(target, created, type);
    return created;
  } catch {
    return null;
  }
}

function version(entry: string): string {
  return execFileSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
  }).trim();
}

const viaDirLink = link(path.join(root, 'dist'), 'dist-link', 'junction');
const viaFileLink = link(cli, 'contextbill', 'file');

describe('CLI entry point', () => {
  it('runs when node is handed the file directly', () => {
    expect(version(cli)).toBe(manifest.version);
  });

  it('runs when argv[1] resolves elsewhere', () => {
    // Guarded rather than skipped: if neither link form can be created the
    // machine cannot exercise this at all, and silently reporting a pass would
    // recreate the exact blind spot that let the bug ship.
    expect(viaDirLink, 'could not create a directory link to test through').not.toBeNull();
    expect(version(path.join(viaDirLink as string, 'cli.js'))).toBe(manifest.version);
  });

  it.skipIf(viaFileLink === null)('runs through a file symlink, the shape npm installs', () => {
    expect(version(viaFileLink as string)).toBe(manifest.version);
  });
});
