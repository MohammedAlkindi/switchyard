import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../src/commands/spawn.js';
import { gitAt } from '../src/lib/git.js';
import { parseSourceAst, predictSemanticConflicts } from '../src/lib/semantic.js';
import { commitFile, makeTempRepo, worktreePath } from './helpers.js';
import type { TempRepo } from './helpers.js';

let repo: TempRepo;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  repo = await makeTempRepo();
});

afterEach(() => {
  vi.restoreAllMocks();
  repo.cleanup();
});

describe('AST Parser (parseSourceAst)', () => {
  it('extracts exported functions with parameter types and return type', () => {
    const code = 'export function add(a: number, b: number): number { return a + b; }';
    const result = parseSourceAst('math.ts', code);
    expect(result.exports.has('add')).toBe(true);
    const sym = result.exports.get('add')!;
    expect(sym.kind).toBe('function');
    expect(sym.signature).toBe('(a: number, b: number): number');
  });

  it('extracts exported interfaces and types', () => {
    const code = `
      export interface User { id: string; email: string; }
      export type Role = 'admin' | 'user';
    `;
    const result = parseSourceAst('user.ts', code);
    expect(result.exports.get('User')?.kind).toBe('interface');
    expect(result.exports.get('Role')?.kind).toBe('type');
  });

  it('extracts imported symbols and identifier usages', () => {
    const code = `
      import { add } from './math';
      export function calc() { return add(1, 2); }
    `;
    const result = parseSourceAst('calc.ts', code);
    expect(result.imports.get('add')).toBe('./math');
    expect(result.identifiers.has('add')).toBe(true);
    expect(result.identifiers.has('calc')).toBe(true);
  });
});

describe('Semantic Conflict Prediction (predictSemanticConflicts)', () => {
  it('catches cross-file function signature changes that git merge-tree considers clean', async () => {
    // Base repo setup: provider calc.ts and consumer app.ts
    await commitFile(
      repo.root,
      'src/calc.ts',
      'export function compute(a: number): number {\n  return a * 2;\n}\n',
      'chore: base calc',
    );
    await commitFile(
      repo.root,
      'src/app.ts',
      "import { compute } from './calc';\nexport function run(): number {\n  return compute(5);\n}\n",
      'chore: base app',
    );

    // Agent Alice mutates compute signature in calc.ts
    await spawn('alice', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'alice'),
      'src/calc.ts',
      'export function compute(a: number, b: number): number {\n  return a * b;\n}\n',
      'feat: add parameter to compute',
    );

    // Agent Bob touches app.ts without updating caller
    await spawn('bob', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'bob'),
      'src/app.ts',
      "import { compute } from './calc';\nexport function run(): number {\n  console.log('Running');\n  return compute(5);\n}\n",
      'feat: add logging to app',
    );

    const result = await predictSemanticConflicts(
      gitAt(repo.root),
      { name: 'alice', branch: 'fleet/alice' },
      { name: 'bob', branch: 'fleet/bob' },
    );

    expect(result.hasHazards).toBe(true);
    expect(result.hazards.length).toBeGreaterThanOrEqual(1);
    expect(result.hazards[0]?.symbol).toBe('compute');
    expect(result.hazards[0]?.type).toBe('breaking_contract_change');
  });

  it('catches deleted exports that another agent imports', async () => {
    await commitFile(
      repo.root,
      'src/auth.ts',
      'export function verify(t: string): boolean { return true; }\n',
      'chore: base auth',
    );
    await commitFile(
      repo.root,
      'src/gate.ts',
      "import { verify } from './auth';\nexport function pass() { return verify('token'); }\n",
      'chore: base gate',
    );

    await spawn('alice', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'alice'),
      'src/auth.ts',
      '// removed verify\nexport function newVerify(): boolean { return true; }\n',
      'refactor: remove verify',
    );

    await spawn('bob', { cwd: repo.root });
    await commitFile(
      worktreePath(repo.root, 'bob'),
      'src/gate.ts',
      "import { verify } from './auth';\nexport function pass() {\n  console.log('gating');\n  return verify('token');\n}\n",
      'feat: log gate',
    );

    const result = await predictSemanticConflicts(
      gitAt(repo.root),
      { name: 'alice', branch: 'fleet/alice' },
      { name: 'bob', branch: 'fleet/bob' },
    );

    expect(result.hasHazards).toBe(true);
    expect(result.hazards[0]?.symbol).toBe('verify');
    expect(result.hazards[0]?.type).toBe('deleted_symbol');
  });

  it('reports zero hazards for benign disjoint edits', async () => {
    await commitFile(repo.root, 'src/math.ts', 'export function add() {}\n', 'chore: base');

    await spawn('alice', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'src/featureA.ts', 'export const A = 1;\n', 'feat: a');

    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'bob'), 'src/featureB.ts', 'export const B = 2;\n', 'feat: b');

    const result = await predictSemanticConflicts(
      gitAt(repo.root),
      { name: 'alice', branch: 'fleet/alice' },
      { name: 'bob', branch: 'fleet/bob' },
    );

    expect(result.hasHazards).toBe(false);
    expect(result.hazards).toHaveLength(0);
  });
});
