import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as lib from '../index.js';

/**
 * `src/index.ts` is the published library surface. Two things about it are
 * promises rather than preferences, and neither fails loudly on its own:
 *
 *   1. Nothing reachable from it may import a Node built-in. That is what lets
 *      a consumer bundle it for a browser, and it is the same property the web
 *      app already depends on via `parse.ts`. Adding one export from `scan.ts`
 *      breaks it — in someone else's build, not in ours.
 *   2. The `exports` map has to point at files the tarball actually contains,
 *      and must not start shipping `web/`.
 *
 * The graph walk reads SOURCE, not dist/, so it passes in a fresh clone.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = path.join(root, 'src');

interface Manifest {
  exports?: Record<string, unknown>;
  files?: string[];
  main?: string;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
) as Manifest;

/** Every relative specifier in a module, `import` and `export ... from` alike. */
function relativeImports(text: string): string[] {
  const out: string[] = [];
  // Deliberately crude: it matches the `from './x.js'` tail that every import
  // and re-export in this codebase ends with, including `export type * from`.
  for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/** Node built-in specifiers, in both the prefixed and bare forms. */
function nodeImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/from\s+'(node:[^']+|fs|os|path|url|child_process)'/g)) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/** Walk the import graph from `src/index.ts`, returning every file reached. */
function moduleGraph(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = ['index.ts'];
  while (queue.length > 0) {
    const rel = queue.pop() as string;
    if (seen.has(rel)) continue;
    const text = fs.readFileSync(path.join(src, rel), 'utf8');
    seen.set(rel, text);
    for (const spec of relativeImports(text)) {
      // Emitted specifiers end in .js; the source they resolve to is .ts.
      queue.push(spec.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
    }
  }
  return seen;
}

describe('library entry point', () => {
  it('reaches no Node built-in, so it can be bundled for a browser', () => {
    const offenders: string[] = [];
    for (const [file, text] of moduleGraph()) {
      for (const spec of nodeImports(text)) offenders.push(`${file} imports ${spec}`);
    }
    expect(offenders, 'src/index.ts must not reach node:fs — see the header there').toEqual([]);
  });

  it('does not re-export the two modules that own the filesystem and the process', () => {
    // Named explicitly rather than left to the walk above: `cli.ts` imports
    // node:fs directly, so the graph test would catch it, but the reason it is
    // excluded is not "it imports fs" — it is that it owns `process` and calls
    // `process.exit`, which no importable module may do.
    const graph = [...moduleGraph().keys()];
    expect(graph).not.toContain('scan.ts');
    expect(graph).not.toContain('cli.ts');
  });

  it('actually exports the pure pieces, at runtime and not just in types', () => {
    for (const name of [
      'parseTranscript',
      'parseCodexRollout',
      'priceAll',
      'priceModelUsage',
      'cacheWriteMultiplier',
      'aggregate',
      'monthlyProjection',
      'classify',
      'redactProject',
      'renderReport',
      'usd',
    ] as const) {
      expect(typeof lib[name], `${name} should be exported as a function`).toBe('function');
    }
  });

  it('prices a transcript end to end through the exported functions alone', () => {
    // The library's whole claim is that a consumer does not have to shell out
    // to the CLI. This is that claim, executed: text in, dollars out, with the
    // caller doing its own file reading.
    const file = path.join(root, 'fixtures', 'projects', 'demo-project', 'session-a.jsonl');
    const text = fs.readFileSync(file, 'utf8');
    const table = JSON.parse(
      fs.readFileSync(path.join(root, 'prices.json'), 'utf8'),
    ) as lib.PriceTable;

    const stat = lib.parseTranscript(text, {
      id: 'session-a',
      project: 'demo-project',
      isSubagent: false,
      bytes: text.length,
    });
    expect(stat.turns).toBeGreaterThan(0);

    const priced = lib.priceAll(stat.byModel, table, '5m');
    expect(priced.cost.total).toBeGreaterThan(0);

    const report = lib.aggregate([stat], {
      table,
      ttl: '5m',
      cacheWriteMult: lib.cacheWriteMultiplier(table, '5m'),
      topN: 5,
    });
    // The two paths must agree: an aggregate over one stat is that stat priced.
    expect(report.cost.total).toBeCloseTo(priced.cost.total, 12);
  });
});

describe('published exports map', () => {
  it('points the package root at a file the tarball ships', () => {
    const rootEntry = manifest.exports?.['.'] as Record<string, string> | undefined;
    expect(rootEntry?.['default']).toBe('./dist/index.js');
    expect(rootEntry?.['types']).toBe('./dist/index.d.ts');
    expect(manifest.files ?? []).toContain('dist/**/*.js');
    expect(manifest.files ?? []).toContain('dist/**/*.d.ts');
  });

  it('exposes the price table, because every dollar figure needs it', () => {
    expect(manifest.exports?.['./prices.json']).toBe('./prices.json');
    expect(manifest.files ?? []).toContain('prices.json');
  });

  it('still keeps web/ out of the tarball', () => {
    // `files` is an allowlist, so the guarantee is that nothing in it names
    // web/ — not that something excludes it.
    for (const entry of manifest.files ?? []) {
      expect(entry.startsWith('web')).toBe(false);
    }
  });

  it('adds no "main", because an exports map already answers the question', () => {
    // package.test.ts asserts the same thing for a different reason: "main" once
    // named an index.js that was in neither the repo nor the tarball. Keeping it
    // absent means there is exactly one answer to where the entry point is.
    expect(manifest.main).toBeUndefined();
  });
});
