import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectCheck } from '../src/commands/check.js';
import { spawn } from '../src/commands/spawn.js';
import { gitAt } from '../src/lib/git.js';
import { parsePythonSource } from '../src/lib/pysymbols.js';
import {
  LEGACY_SEMANTIC,
  PRECISE_SEMANTIC,
  breakingReason,
  isBreakingParamChange,
  predictSemanticConflicts,
  readBlobs,
  specifierResolvesTo,
} from '../src/lib/semantic.js';
import type { Param, SymbolInfo } from '../src/lib/semantic.js';
import { commitFile, makeTempRepo, worktreePath } from './helpers.js';
import type { TempRepo } from './helpers.js';

const p = (name: string, optional = false, kind: Param['kind'] = 'normal', type = ''): Param => ({ name, kind, optional, type });

describe('Python symbol extraction (parsePythonSource)', () => {
  const src = [
    'import os',
    'from .util import helper as h, other',
    'from pkg.sub import (a,',
    '    b)',
    '',
    'LIMIT: int = 10',
    '',
    'def top(x, y=1, *args, key, **kw) -> str:',
    '    """Docstring mentioning fake_name(1, 2)."""',
    '    def inner(z):  # nested: not a contract',
    '        return z',
    '    return "def not_a_def(q):"',
    '',
    '@dataclass',
    'class Box(Base, metaclass=Meta):',
    '    size: int = 0',
    '    def __init__(self, size):',
    '        self.size = size',
    '    @staticmethod',
    '    def make(n):',
    '        return Box(n)',
    '    @property',
    '    def area(self):',
    '        return 0',
    '    def _private(self):',
    '        pass',
    '',
    'async def fetch(',
    '    url,',
    '    timeout=None,',
    '):',
    '    pass',
  ].join('\n');
  const s = parsePythonSource('pkg/mod.py', src);

  it('records top-level functions with structured parameters', () => {
    const top = s.exports.get('top');
    expect(top?.kind).toBe('function');
    expect(top?.params?.map((x) => `${x.kind}:${x.name}${x.optional ? '=' : ''}`)).toEqual([
      'normal:x',
      'normal:y=',
      'varargs:args=',
      'keyword:key',
      'varkw:kw=',
    ]);
    expect(top?.returnType).toBe('str');
  });

  it('ignores nested defs and text inside strings and comments', () => {
    expect(s.exports.has('inner')).toBe(false);
    expect(s.exports.has('not_a_def')).toBe(false);
    expect(s.identifiers.has('fake_name')).toBe(false);
  });

  it('records classes, methods (receiver dropped), static methods, properties and class attributes', () => {
    expect(s.exports.get('Box')?.signature).toBe('(Base, metaclass=Meta)');
    expect(s.exports.get('Box.__init__')?.params?.map((x) => x.name)).toEqual(['size']);
    expect(s.exports.get('Box.make')?.decorators).toEqual(['staticmethod']);
    expect(s.exports.get('Box.make')?.params?.map((x) => x.name)).toEqual(['n']);
    expect(s.exports.get('Box.area')?.params).toBeUndefined();
    expect(s.exports.has('Box.size')).toBe(true);
  });

  it('joins multi-line signatures and records async defs and module variables', () => {
    expect(s.exports.get('fetch')?.params?.map((x) => x.name)).toEqual(['url', 'timeout']);
    expect(s.exports.get('LIMIT')?.kind).toBe('variable');
  });

  it('maps imports to their module and original name', () => {
    expect(s.imports.get('h')).toBe('.util');
    expect(s.importNames?.get('h')).toBe('helper');
    expect(s.imports.get('b')).toBe('pkg.sub');
    expect(s.importedModules?.get('os')).toBe('os');
    expect(s.module).toBe('pkg/mod');
  });
});

describe('breaking-change classification', () => {
  it('treats added optional parameters and **kwargs as compatible', () => {
    expect(isBreakingParamChange([p('a')], [p('a'), p('b', true)], false)).toBeUndefined();
    expect(isBreakingParamChange([p('a')], [p('a'), p('kw', true, 'varkw')], false)).toBeUndefined();
    expect(isBreakingParamChange([p('a'), p('b')], [p('a'), p('b', true)], false)).toBeUndefined();
  });

  it('flags new required, removed, renamed, keyword-only and lost-default changes', () => {
    expect(isBreakingParamChange([p('a')], [p('a'), p('b')], false)).toMatch(/new required/);
    expect(isBreakingParamChange([p('a'), p('b')], [p('a')], false)).toMatch(/removed/);
    expect(isBreakingParamChange([p('a')], [p('x')], false)).toMatch(/renamed/);
    expect(isBreakingParamChange([p('a'), p('b')], [p('a'), p('b', false, 'keyword')], false)).toMatch(/keyword-only/);
    expect(isBreakingParamChange([p('a', true)], [p('a')], false)).toMatch(/default/);
  });

  it('counts type changes only for typed languages', () => {
    expect(isBreakingParamChange([p('a', false, 'normal', 'int')], [p('a', false, 'normal', 'str')], false)).toBeUndefined();
    expect(isBreakingParamChange([p('a', false, 'normal', 'number')], [p('a', false, 'normal', 'string')], true)).toMatch(/type/);
  });

  it('does not treat a Python value change as a contract change', () => {
    const v = (sig: string): SymbolInfo => ({ name: 'X', kind: 'variable', signature: sig, lineStart: 1, lineEnd: 1 });
    expect(breakingReason(v('int'), v('str'), 'python')).toBeUndefined();
  });
});

describe('module specifier resolution', () => {
  it('resolves Python absolute and relative imports', () => {
    expect(specifierResolvesTo('django.db.models.query', 'app/x.py', 'django/db/models/query', 'python')).toBe(true);
    expect(specifierResolvesTo('.query', 'django/db/models/x.py', 'django/db/models/query', 'python')).toBe(true);
    expect(specifierResolvesTo('..query', 'django/db/models/sub/x.py', 'django/db/models/query', 'python')).toBe(true);
    expect(specifierResolvesTo('other.query', 'app/x.py', 'django/db/models/query', 'python')).toBe(false);
  });

  it('resolves TypeScript relative specifiers with or without extension', () => {
    expect(specifierResolvesTo('./calc', 'src/app.ts', 'src/calc', 'typescript')).toBe(true);
    expect(specifierResolvesTo('./calc.js', 'src/app.ts', 'src/calc', 'typescript')).toBe(true);
    expect(specifierResolvesTo('../lib', 'src/app/x.ts', 'src/lib/index', 'typescript')).toBe(true);
    expect(specifierResolvesTo('calc', 'src/app.ts', 'src/calc', 'typescript')).toBe(false);
  });
});

describe('precise semantic prediction against real branches', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    repo = await makeTempRepo();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    repo.cleanup();
  });

  async function twoAgents(
    base: Record<string, string>,
    alice: Record<string, string>,
    bob: Record<string, string>,
  ) {
    for (const [f, c] of Object.entries(base)) await commitFile(repo.root, f, c, `chore: base ${f}`);
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    for (const [f, c] of Object.entries(alice)) await commitFile(worktreePath(repo.root, 'alice'), f, c, `feat: alice ${f}`);
    for (const [f, c] of Object.entries(bob)) await commitFile(worktreePath(repo.root, 'bob'), f, c, `feat: bob ${f}`);
    const run = (opts = PRECISE_SEMANTIC) =>
      predictSemanticConflicts(gitAt(repo.root), { name: 'alice', branch: 'fleet/alice' }, { name: 'bob', branch: 'fleet/bob' }, opts, {
        cwd: repo.root,
      });
    return run;
  }

  it('flags a new Python caller of a function whose signature became incompatible', async () => {
    const run = await twoAgents(
      { 'pkg/calc.py': 'def compute(a):\n    return a\n' },
      { 'pkg/calc.py': 'def compute(a, b):\n    return a * b\n' },
      { 'pkg/app.py': 'from pkg.calc import compute\n\n\ndef run():\n    return compute(5)\n' },
    );
    const r = await run();
    expect(r.hazards.map((h) => [h.type, h.symbol, h.consumerFile])).toEqual([['breaking_contract_change', 'compute', 'pkg/app.py']]);
  });

  it('does not flag a compatible extension (new optional parameter); legacy does', async () => {
    const run = await twoAgents(
      { 'pkg/calc.py': 'def compute(a):\n    return a\n' },
      { 'pkg/calc.py': 'def compute(a, scale=1):\n    return a * scale\n' },
      { 'pkg/app.py': 'from pkg.calc import compute\n\n\ndef run():\n    return compute(5)\n' },
    );
    expect((await run()).hasHazards).toBe(false);
    expect((await run(LEGACY_SEMANTIC)).hasHazards).toBe(true);
  });

  it('does not flag a same-named local function that never imports the provider; legacy does', async () => {
    const run = await twoAgents(
      { 'pkg/calc.py': 'def compute(a):\n    return a\n' },
      { 'pkg/calc.py': 'def compute(a, b):\n    return a * b\n' },
      { 'pkg/app.py': 'def compute(*args):\n    return None\n\n\ndef run():\n    return compute(1)\n' },
    );
    expect((await run()).hasHazards).toBe(false);
    expect((await run(LEGACY_SEMANTIC)).hasHazards).toBe(true);
  });

  it('reaches constructor changes through the class name', async () => {
    const run = await twoAgents(
      { 'pkg/box.py': 'class Box:\n    def __init__(self, size):\n        self.size = size\n' },
      { 'pkg/box.py': 'class Box:\n    def __init__(self, size, colour):\n        self.size = size\n' },
      { 'pkg/use.py': 'from pkg.box import Box\n\n\ndef make():\n    return Box(1)\n' },
    );
    expect((await run()).hazards.map((h) => h.symbol)).toEqual(['Box.__init__']);
  });

  it('ignores references that already existed at the merge base (the provider broke its own callers)', async () => {
    const run = await twoAgents(
      {
        'src/calc.ts': 'export function compute(a: number): number {\n  return a * 2;\n}\n',
        'src/app.ts': "import { compute } from './calc';\nexport function run(): number {\n  return compute(5);\n}\n",
      },
      { 'src/calc.ts': 'export function compute(a: number, b: number): number {\n  return a * b;\n}\n' },
      { 'src/app.ts': "import { compute } from './calc';\nexport function run(): number {\n  console.log('x');\n  return compute(5);\n}\n" },
    );
    expect((await run()).hasHazards).toBe(false);
    expect((await run(LEGACY_SEMANTIC)).hasHazards).toBe(true);
  });

  it('flags a TypeScript caller the other agent added, resolved through a .js specifier', async () => {
    const run = await twoAgents(
      {
        'src/calc.ts': 'export function compute(a: number): number {\n  return a * 2;\n}\nexport function keep(): number {\n  return 1;\n}\n',
      },
      { 'src/calc.ts': 'export function compute(a: number, b: number): number {\n  return a * b;\n}\nexport function keep(): number {\n  return 1;\n}\n' },
      { 'src/new.ts': "import { compute, keep } from './calc.js';\nexport const v = compute(1) + keep();\n" },
    );
    const r = await run();
    expect(r.hazards.map((h) => [h.symbol, h.consumerFile])).toEqual([['compute', 'src/new.ts']]);
  });

  it('ignores a TypeScript body-only change to an exported class method', async () => {
    const run = await twoAgents(
      { 'src/svc.ts': 'export class Svc {\n  get(id: string): string {\n    return id;\n  }\n}\n' },
      { 'src/svc.ts': 'export class Svc {\n  get(id: string): string {\n    return id.trim();\n  }\n}\n' },
      { 'src/use.ts': "import { Svc } from './svc';\nexport const x = new Svc().get('a');\n" },
    );
    expect((await run()).hasHazards).toBe(false);
    expect((await run(LEGACY_SEMANTIC)).hasHazards).toBe(true);
  });

  it('flags an intra-file call appended by the other agent', async () => {
    const run = await twoAgents(
      { 'pkg/calc.py': 'def compute(a):\n    return a\n\n\ndef other():\n    return 1\n' },
      { 'pkg/calc.py': 'def compute(a, *, mode):\n    return a\n\n\ndef other():\n    return 1\n' },
      { 'pkg/calc.py': 'def compute(a):\n    return a\n\n\ndef other():\n    return 1\n\n\ndef added():\n    return compute(2)\n' },
    );
    expect((await run()).hazards.map((h) => [h.type, h.symbol])).toEqual([['intra_file_hazard', 'compute']]);
  });

  it('reads blobs in one batch, returning null for paths missing at a ref', async () => {
    await commitFile(repo.root, 'a.txt', 'hello\n', 'chore: add a');
    const [a, missing] = await readBlobs(repo.root, ['HEAD:a.txt', 'HEAD:nope.txt']);
    expect(a).toBe('hello\n');
    expect(missing).toBeNull();
  });

  it('fleet check --semantic uses the precise rules', async () => {
    await twoAgents(
      { 'pkg/calc.py': 'def compute(a):\n    return a\n' },
      { 'pkg/calc.py': 'def compute(a, scale=1):\n    return a * scale\n' },
      { 'pkg/app.py': 'from pkg.calc import compute\n\n\ndef run():\n    return compute(5)\n' },
    );
    const res = await collectCheck({ cwd: repo.root, semantic: true });
    expect(res.semanticHazards).toEqual([]);
  });
});
