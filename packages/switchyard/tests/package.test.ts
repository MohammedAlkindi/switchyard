import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface PackResult {
  files: { path: string }[];
}

let cached: string[] | undefined;

/**
 * Ask npm what would actually ship. The `files` field is easy to change and
 * easy to get wrong, and a missing entry is only discovered after publishing.
 *
 * Packing runs the `prepare` build, so the answer is memoized for the file.
 */
function packedFiles(): string[] {
  if (cached !== undefined) return cached;
  // A single command string, not an argv array: npm is a .cmd shim on Windows,
  // which Node refuses to spawn without a shell, and passing separate args
  // through a shell is deprecated. The string is a constant — nothing is
  // interpolated into it.
  const raw = execSync('npm pack --dry-run --json', { cwd: ROOT, encoding: 'utf8' });
  const [result] = JSON.parse(raw) as PackResult[];
  if (result === undefined) throw new Error('npm pack returned no tarball description');
  cached = result.files.map((f) => f.path.replace(/\\/g, '/'));
  return cached;
}

describe('published package contents', () => {
  it('ships the Claude Code skill', () => {
    // Shipping the skill is how the "check before editing" convention travels;
    // the tools alone cannot convey it.
    expect(packedFiles()).toContain('skills/switchyard/SKILL.md');
  });

  it('ships the compiled CLI and the config schema', () => {
    const files = packedFiles();
    expect(files).toContain('dist/cli.js');
    expect(files).toContain('dist/commands/mcp.js');
    // `fleet init` reads the packaged skill at runtime; both must ship.
    expect(files).toContain('dist/commands/init.js');
    expect(files.some((f) => f.startsWith('schema/'))).toBe(true);
  });

  it('statically imports only declared runtime dependencies and node builtins', () => {
    // A devDependency imported at module top level crashes every command of an
    // installed CLI (`typescript` in semantic.js did exactly that). dist/ is
    // built by the global setup.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const allowed = new Set([...Object.keys(pkg.dependencies), ...builtinModules]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.endsWith('.js')) {
          const src = readFileSync(abs, 'utf8');
          // `import x from 'y'`, `import 'y'`, `export ... from 'y'` — not `import type` (erased) or dynamic import().
          for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
            const spec = (m[1] ?? m[2]) as string;
            if (spec.startsWith('.')) continue;
            const name = spec.startsWith('node:') ? spec.slice(5) : spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
            if (!allowed.has(name as string)) offenders.push(`${path.relative(ROOT, abs)}: ${spec}`);
          }
        }
      }
    };
    walk(path.join(ROOT, 'dist'));
    expect(offenders).toEqual([]);
  });

  it('does not ship tests, sources, or docs', () => {
    const files = packedFiles();
    expect(files.some((f) => f.startsWith('tests/'))).toBe(false);
    expect(files.some((f) => f.startsWith('src/'))).toBe(false);
    expect(files.some((f) => f.startsWith('docs/'))).toBe(false);
  });
});
