import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The published tarball is the product, and nothing else in this suite looks at
 * it. Every assertion below either failed once for real or guards a property
 * the README sells.
 *
 * These read the manifest and the CLI source, never `dist/`, so they pass in a
 * fresh clone before anything has been built.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Manifest {
  main?: string;
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
) as Manifest;

describe('published package', () => {
  it('rebuilds dist before packing, because dist is gitignored', () => {
    // The failure this prevents: `npm publish` from a fresh clone. dist/ is in
    // .gitignore, so with no pack-time build npm ships a tarball containing no
    // dist/ at all and `npx contextbill` dies on "Cannot find module
    // .../dist/cli.js". Measured on a clean clone: 4 files / 5.8 kB, against
    // 26 files / 25.6 kB from a built tree. npm will not let that version
    // number be reused, so the first publish is the one that cannot be retried.
    const prepack = manifest.scripts?.prepack;
    expect(prepack, 'package.json needs a prepack script that builds dist/').toBeDefined();
    expect(prepack).toContain('build');
  });

  it('ships the file bin points at', () => {
    expect(manifest.bin?.['contextbill']).toBe('./dist/cli.js');
    expect(manifest.files ?? []).toContain('dist/**/*.js');
  });

  it('keeps the shebang on the CLI entry point', () => {
    // Without it npx hands the file to the shell instead of node.
    const cli = fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8');
    expect(cli.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('ships zero runtime dependencies', () => {
    // `npx contextbill` staying instant and auditable is a product claim, not
    // a preference. One transitive dependency ends it.
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('does not advertise an entry point it does not ship', () => {
    // "main": "index.js" named a file present in neither the repo nor the
    // tarball. This package is a binary; it has no library entry.
    expect(manifest.main).toBeUndefined();
  });
});
