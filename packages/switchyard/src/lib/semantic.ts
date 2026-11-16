import { spawn as spawnProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import type * as TS from 'typescript';
import { FleetError } from './errors.js';
import { parsePythonSource } from './pysymbols.js';

export interface Param {
  name: string;
  /** positional = positional-only; normal = positional or keyword; keyword = keyword-only. */
  kind: 'positional' | 'normal' | 'keyword' | 'varargs' | 'varkw';
  optional: boolean;
  /** Declared type text ('' when none). */
  type: string;
}

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'method' | 'interface' | 'type' | 'enum' | 'class' | 'variable';
  /** Normalized declaration text. Any change here is a "contract change" in legacy mode. */
  signature: string;
  /** Structured parameters for callables; undefined for non-callables. */
  params?: Param[];
  returnType?: string;
  decorators?: string[];
  /** Class members (names only). */
  members?: string[];
  /** Enum members (names only). */
  enumMembers?: string[];
  lineStart: number;
  lineEnd: number;
}

/** @deprecated kept for API compatibility; use SymbolInfo. */
export type ExportedSymbol = SymbolInfo;

export interface FileAstSummary {
  language?: 'typescript' | 'python';
  /** Module path without extension (Python: without `/__init__`). */
  module?: string;
  exports: Map<string, SymbolInfo>;
  imports: Map<string, string>; // local name -> module specifier
  /** local name -> original exported name (differs only for `as` aliases). */
  importNames?: Map<string, string>;
  /** local alias -> module specifier for whole-module imports (`import x`, `import * as x`). */
  importedModules?: Map<string, string>;
  identifiers: Set<string>;
  identifierCounts?: Map<string, number>;
  /** identifier -> 1-based lines it occurs on (code only, not strings/comments). */
  identifierLines?: Map<string, number[]>;
  /** Raw source lines, for the added-lines diff. */
  sourceLines?: string[];
}

export interface SemanticHazard {
  type: 'breaking_contract_change' | 'deleted_symbol' | 'intra_file_hazard';
  symbol: string;
  providerFile: string;
  consumerFile: string;
  providerAgent: string;
  consumerAgent: string;
  details: string;
}

export interface SemanticPrediction {
  hazards: SemanticHazard[];
  hasHazards: boolean;
  durationMs: number;
}

/**
 * How the filter decides a consumer depends on a changed symbol, and which
 * changes count. `legacy` is the filter as first shipped (0.5.x Unreleased);
 * `precise` is the default for `fleet check --semantic` since the P3
 * evaluation (research/2026-11-switchyard-roadmap.md) measured both.
 */
export interface SemanticOptions {
  /** name: any identifier with the symbol's name. import: the consumer must import it from the provider module (or be the provider file). */
  resolution?: 'name' | 'import';
  /** any-change: any declaration text change. breaking: only changes that can break an existing caller. */
  compat?: 'any-change' | 'breaking';
  /** Count only references the consumer agent added, not ones already present at the merge base. */
  addedReferencesOnly?: boolean;
  /** Treat a file the provider deleted as deleting all its symbols. */
  fileDeletions?: boolean;
  /** Check shared files in both directions (legacy checked only agentA as provider). */
  bidirectionalIntraFile?: boolean;
}

export const LEGACY_SEMANTIC: Required<SemanticOptions> = {
  resolution: 'name',
  compat: 'any-change',
  addedReferencesOnly: false,
  fileDeletions: false,
  bidirectionalIntraFile: false,
};

export const PRECISE_SEMANTIC: Required<SemanticOptions> = {
  resolution: 'import',
  compat: 'breaking',
  addedReferencesOnly: true,
  fileDeletions: true,
  bidirectionalIntraFile: true,
};

// ---------------------------------------------------------------------------
// TypeScript adapter. `typescript` is loaded on first use, never at import
// time: it is not one of the CLI's runtime dependencies, so a plain install
// must be able to run every command that does not ask for --semantic.
// ---------------------------------------------------------------------------

let tsModule: typeof TS | undefined;

function loadTypeScript(): typeof TS {
  if (tsModule) return tsModule;
  try {
    const req = createRequire(import.meta.url);
    let resolved: string;
    try {
      resolved = req.resolve('typescript');
    } catch {
      // Not next to the CLI: try the repository being checked.
      resolved = createRequire(path.join(process.cwd(), 'noop.js')).resolve('typescript');
    }
    tsModule = req(resolved) as typeof TS;
    return tsModule;
  } catch {
    throw new FleetError(
      'Semantic checks on TypeScript/JavaScript files need the "typescript" package. ' +
        'Install it next to switchyard or in the repository (npm i -D typescript).',
    );
  }
}

function tsParams(ts: typeof TS, sf: TS.SourceFile, params: TS.NodeArray<TS.ParameterDeclaration>): Param[] {
  return params
    .filter((p) => p.name.getText(sf) !== 'this')
    .map((p) => ({
      name: p.name.getText(sf),
      kind: p.dotDotDotToken ? 'varargs' : 'normal',
      optional: Boolean(p.questionToken || p.initializer || p.dotDotDotToken),
      type: p.type ? p.type.getText(sf).replace(/\s+/g, ' ') : '',
    }));
}

/** Member header without its body, so a body edit is not a contract change. */
function tsMemberHeader(ts: typeof TS, sf: TS.SourceFile, m: TS.ClassElement | TS.TypeElement): string {
  const name = m.name ? m.name.getText(sf) : '';
  const isPrivate = ts.canHaveModifiers(m) && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword);
  if (isPrivate || name.startsWith('#')) return '';
  if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isConstructorDeclaration(m)) {
    const ps = tsParams(ts, sf, m.parameters)
      .map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`)
      .join(', ');
    const ret = 'type' in m && m.type ? m.type.getText(sf) : '';
    return `${ts.isConstructorDeclaration(m) ? 'constructor' : name}(${ps})${ret ? `: ${ret}` : ''}`;
  }
  if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
    const opt = m.questionToken ? '?' : '';
    return `${name}${opt}: ${m.type ? m.type.getText(sf) : ''}`;
  }
  return m.getText(sf).split('{')[0]?.trim() ?? '';
}

/**
 * Fast in-memory AST parser that extracts exported declarations and symbol usages
 * from a TypeScript or JavaScript source string in sub-millisecond time.
 */
export function parseSourceAst(fileName: string, content: string): FileAstSummary {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const exports = new Map<string, SymbolInfo>();
  const imports = new Map<string, string>();
  const importNames = new Map<string, string>();
  const importedModules = new Map<string, string>();
  const identifiers = new Set<string>();
  const identifierCounts = new Map<string, number>();
  const identifierLines = new Map<string, number[]>();

  function isExported(node: TS.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  }

  function getLineRange(node: TS.Node): { start: number; end: number } {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { start, end };
  }

  function visit(node: TS.Node) {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      identifiers.add(node.text);
      identifierCounts.set(node.text, (identifierCounts.get(node.text) ?? 0) + 1);
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      identifierLines.set(node.text, [...(identifierLines.get(node.text) ?? []), line]);
    }

    if (ts.isImportDeclaration(node) && node.importClause && node.moduleSpecifier) {
      const modulePath = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const spec of bindings.elements) {
          imports.set(spec.name.text, modulePath);
          importNames.set(spec.name.text, spec.propertyName?.text ?? spec.name.text);
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        importedModules.set(bindings.name.text, modulePath);
      }
      if (node.importClause.name) {
        imports.set(node.importClause.name.text, modulePath);
        importNames.set(node.importClause.name.text, 'default');
      }
    }

    if (isExported(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const { start, end } = getLineRange(node);
        const params = node.parameters.map((p) => {
          const typeStr = p.type ? p.type.getText(sourceFile) : 'any';
          return `${p.name.getText(sourceFile)}: ${typeStr}`;
        });
        const returnType = node.type ? node.type.getText(sourceFile) : 'void';
        exports.set(node.name.text, {
          name: node.name.text,
          kind: 'function',
          signature: `(${params.join(', ')}): ${returnType}`,
          params: tsParams(ts, sourceFile, node.parameters),
          returnType: node.type ? node.type.getText(sourceFile) : '',
          lineStart: start,
          lineEnd: end,
        });
      } else if (ts.isInterfaceDeclaration(node)) {
        const { start, end } = getLineRange(node);
        const members = node.members
          .map((m) => m.getText(sourceFile).trim())
          .sort()
          .join('; ');
        exports.set(node.name.text, {
          name: node.name.text,
          kind: 'interface',
          signature: `{ ${members} }`,
          members: node.members.map((m) => tsMemberHeader(ts, sourceFile, m)).filter(Boolean).sort(),
          lineStart: start,
          lineEnd: end,
        });
      } else if (ts.isTypeAliasDeclaration(node)) {
        const { start, end } = getLineRange(node);
        exports.set(node.name.text, {
          name: node.name.text,
          kind: 'type',
          signature: node.type.getText(sourceFile).trim(),
          lineStart: start,
          lineEnd: end,
        });
      } else if (ts.isEnumDeclaration(node)) {
        const { start, end } = getLineRange(node);
        const members = node.members
          .map((m) => m.getText(sourceFile).trim())
          .sort()
          .join(', ');
        exports.set(node.name.text, {
          name: node.name.text,
          kind: 'enum',
          signature: `{ ${members} }`,
          enumMembers: node.members.map((m) => m.name.getText(sourceFile)),
          lineStart: start,
          lineEnd: end,
        });
      } else if (ts.isClassDeclaration(node) && node.name) {
        const { start, end } = getLineRange(node);
        const members = node.members
          .map((m) => m.getText(sourceFile).trim())
          .sort()
          .join('; ');
        exports.set(node.name.text, {
          name: node.name.text,
          kind: 'class',
          signature: `{ ${members} }`,
          members: node.members.map((m) => tsMemberHeader(ts, sourceFile, m)).filter(Boolean).sort(),
          lineStart: start,
          lineEnd: end,
        });
      } else if (ts.isVariableStatement(node)) {
        const { start, end } = getLineRange(node);
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const typeStr = decl.type
            ? decl.type.getText(sourceFile)
            : decl.initializer
              ? decl.initializer.getText(sourceFile)
              : 'any';
          const init = decl.initializer;
          const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
          exports.set(decl.name.text, {
            name: decl.name.text,
            kind: fn ? 'function' : 'variable',
            signature: typeStr,
            params: fn ? tsParams(ts, sourceFile, fn.parameters) : undefined,
            returnType: fn?.type ? fn.type.getText(sourceFile) : decl.type ? decl.type.getText(sourceFile) : '',
            lineStart: start,
            lineEnd: end,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    language: 'typescript',
    module: fileName.replace(/\\/g, '/').replace(/\.(d\.)?(tsx?|jsx?|mjs|cjs|mts|cts)$/, ''),
    exports,
    imports,
    importNames,
    importedModules,
    identifiers,
    identifierCounts,
    identifierLines,
    sourceLines: content.split('\n'),
  };
}

const TS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const PY_FILE = /\.pyi?$/;

export function isSemanticFile(f: string): boolean {
  return TS_FILE.test(f) || PY_FILE.test(f);
}

/** Parse any supported file; null for unsupported extensions. */
export function summarize(fileName: string, content: string): FileAstSummary | null {
  if (PY_FILE.test(fileName)) return parsePythonSource(fileName, content);
  if (TS_FILE.test(fileName)) return parseSourceAst(fileName, content);
  return null;
}

// ---------------------------------------------------------------------------
// Contract comparison
// ---------------------------------------------------------------------------

/**
 * Can a caller written against `base` still call `post`? Conservative: a
 * renamed parameter counts as breaking because keyword callers break.
 */
export function isBreakingParamChange(base: Param[], post: Param[], typed: boolean): string | undefined {
  const positional = (ps: Param[]) => ps.filter((p) => p.kind === 'positional' || p.kind === 'normal');
  const baseP = positional(base);
  const postP = positional(post);
  const postHasVarargs = post.some((p) => p.kind === 'varargs');
  const postHasVarkw = post.some((p) => p.kind === 'varkw');

  for (let i = 0; i < baseP.length; i += 1) {
    const b = baseP[i] as Param;
    const at = postP[i];
    if (!at) {
      if (postHasVarargs && (b.kind === 'positional' || postHasVarkw)) continue;
      const moved = post.find((p) => p.name === b.name);
      return moved ? `parameter "${b.name}" became keyword-only` : `parameter "${b.name}" removed`;
    }
    if (b.kind === 'normal' && at.name !== b.name) return `parameter ${i + 1} renamed or reordered ("${b.name}" -> "${at.name}")`;
    if (b.optional && !at.optional) return `parameter "${b.name}" lost its default`;
    if (b.kind === 'normal' && at.kind === 'positional') return `parameter "${b.name}" became positional-only`;
    if (typed && b.type !== at.type) return `parameter "${b.name}" type changed (${b.type || 'any'} -> ${at.type || 'any'})`;
  }
  for (const b of base.filter((p) => p.kind === 'keyword')) {
    const at = post.find((p) => p.name === b.name && p.kind !== 'positional');
    if (!at && !postHasVarkw) return `keyword parameter "${b.name}" removed`;
    if (at && b.optional && !at.optional) return `parameter "${b.name}" lost its default`;
    if (at && typed && b.type !== at.type) return `parameter "${b.name}" type changed`;
  }
  if (base.some((p) => p.kind === 'varargs') && !postHasVarargs) return 'variadic *args removed';
  if (base.some((p) => p.kind === 'varkw') && !postHasVarkw) return 'variadic **kwargs removed';
  for (let i = baseP.length; i < postP.length; i += 1) {
    const p = postP[i] as Param;
    if (!p.optional) return `new required parameter "${p.name}"`;
  }
  for (const p of post.filter((x) => x.kind === 'keyword')) {
    if (!p.optional && !base.some((b) => b.name === p.name)) return `new required keyword parameter "${p.name}"`;
  }
  return undefined;
}

/** Reason the change breaks existing users, or undefined when it does not. */
export function breakingReason(base: SymbolInfo, post: SymbolInfo, language: 'typescript' | 'python'): string | undefined {
  const typed = language === 'typescript';
  if (base.kind !== post.kind) return `${base.kind} became ${post.kind}`;
  if (base.params && post.params) {
    const decoBase = (base.decorators ?? []).join(',');
    const decoPost = (post.decorators ?? []).join(',');
    if (decoBase !== decoPost) return `decorators changed (${decoBase || 'none'} -> ${decoPost || 'none'})`;
    const r = isBreakingParamChange(base.params, post.params, typed);
    if (r) return r;
    if (typed && (base.returnType ?? '') !== (post.returnType ?? '')) {
      return `return type changed (${base.returnType || 'inferred'} -> ${post.returnType || 'inferred'})`;
    }
    return undefined;
  }
  if (base.params || post.params) return 'callable-ness changed';
  switch (base.kind) {
    case 'class':
    case 'interface': {
      if (!typed) return base.signature !== post.signature ? `bases changed ${base.signature} -> ${post.signature}` : undefined;
      const removed = (base.members ?? []).filter((m) => !(post.members ?? []).includes(m));
      return removed.length > 0 ? `member contract changed: ${removed.slice(0, 3).join('; ')}` : undefined;
    }
    case 'enum': {
      const removed = (base.enumMembers ?? []).filter((m) => !(post.enumMembers ?? []).includes(m));
      return removed.length > 0 ? `enum members removed: ${removed.join(', ')}` : undefined;
    }
    case 'type':
      return base.signature !== post.signature ? 'type alias changed' : undefined;
    case 'variable':
      // Python: a value or annotation change does not break importers.
      // TypeScript: only a declared type change is (a value change is not).
      if (!typed) return undefined;
      return base.returnType && post.returnType && base.returnType !== post.returnType
        ? `declared type changed (${base.returnType} -> ${post.returnType})`
        : undefined;
    default:
      return base.signature !== post.signature ? 'declaration changed' : undefined;
  }
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Does a module specifier written in `consumerFile` resolve to `providerModule`? */
export function specifierResolvesTo(
  spec: string,
  consumerFile: string,
  providerModule: string,
  language: 'typescript' | 'python',
): boolean {
  const target = posix(providerModule);
  if (language === 'typescript') {
    if (!spec.startsWith('.')) return false; // bare/aliased specifiers: not resolved (precision over recall)
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(posix(consumerFile)), spec));
    const noExt = joined.replace(/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/, '');
    return noExt === target || noExt === `${target.replace(/\/index$/, '')}` || `${noExt}/index` === target;
  }
  // Python
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
  const rest = spec.slice(dots).replace(/\./g, '/');
  if (dots > 0) {
    let dir = path.posix.dirname(posix(consumerFile));
    for (let k = 1; k < dots; k += 1) dir = path.posix.dirname(dir);
    const resolved = rest ? path.posix.join(dir, rest) : dir;
    return path.posix.normalize(resolved) === target;
  }
  return target === rest || target.endsWith(`/${rest}`);
}

interface RefQuery {
  symbol: string; // qualified, e.g. "Query.filter" or "compute"
  providerFile: string;
  provider: FileAstSummary;
}

const addedCache = new WeakMap<FileAstSummary, { base: FileAstSummary; lines: Set<number> }>();

/**
 * 1-based lines of `post` that are not in `base` (multiset match on trimmed
 * text): the lines an agent added or changed. Cheap and diff-free; a moved
 * line counts as unchanged.
 */
function addedLines(base: FileAstSummary, post: FileAstSummary): Set<number> {
  const hit = addedCache.get(post);
  if (hit && hit.base === base) return hit.lines;
  const pool = new Map<string, number>();
  for (const l of base.sourceLines ?? []) pool.set(l.trim(), (pool.get(l.trim()) ?? 0) + 1);
  const lines = new Set<number>();
  (post.sourceLines ?? []).forEach((l, i) => {
    const k = pool.get(l.trim()) ?? 0;
    if (k > 0) pool.set(l.trim(), k - 1);
    else lines.add(i + 1);
  });
  addedCache.set(post, { base, lines });
  return lines;
}

/** Did the consumer agent add or change a line that references `id`? */
function addedReference(base: FileAstSummary | null, post: FileAstSummary, id: string): boolean {
  if (!base) return post.identifiers.has(id);
  const occ = post.identifierLines?.get(id);
  if (!occ || !post.sourceLines || !base.sourceLines) return countOf(post, id) > countOf(base, id);
  const added = addedLines(base, post);
  return occ.some((l) => added.has(l));
}

function countOf(s: FileAstSummary | null, id: string): number {
  if (!s) return 0;
  if (s.identifierCounts) return s.identifierCounts.get(id) ?? 0;
  return s.identifiers.has(id) ? 1 : 0;
}

/** Does the consumer (post version, with base version for "added" checks) reference the symbol? */
export function referencesSymbol(
  q: RefQuery,
  consumerFile: string,
  consumerBase: FileAstSummary | null,
  consumerPost: FileAstSummary,
  opts: Required<SemanticOptions>,
): boolean {
  const parts = q.symbol.split('.');
  // A constructor change reaches callers through the class name: `C(...)` / `new C(...)`.
  if (parts.length > 1 && (parts[parts.length - 1] === '__init__' || parts[parts.length - 1] === 'constructor')) parts.pop();
  const top = parts[0] as string;
  const leaf = parts[parts.length - 1] as string;

  if (opts.resolution === 'name') {
    const hit = consumerPost.imports.has(q.symbol) || consumerPost.identifiers.has(q.symbol) || consumerPost.identifiers.has(leaf);
    if (!hit) return false;
    return !opts.addedReferencesOnly || addedReference(consumerBase, consumerPost, leaf);
  }

  const language = consumerPost.language ?? 'typescript';
  const providerModule = q.provider.module ?? q.providerFile;
  const sameFile = posix(consumerFile) === posix(q.providerFile);

  // Which local names give access to `top` from the provider module?
  const handles: string[] = [];
  if (sameFile) {
    handles.push(top);
  } else {
    for (const [local, spec] of consumerPost.imports) {
      const orig = consumerPost.importNames?.get(local) ?? local;
      if (orig === top && specifierResolvesTo(spec, consumerFile, providerModule, language)) handles.push(local);
      // Python `from pkg import module` binds the module itself.
      if (language === 'python' && specifierResolvesTo(`${spec}.${orig}`.replace(/^(\.+)\./, '$1'), consumerFile, providerModule, language)) {
        if (consumerPost.identifiers.has(top)) handles.push(top);
      }
    }
    for (const [, spec] of consumerPost.importedModules ?? []) {
      if (specifierResolvesTo(spec, consumerFile, providerModule, language) && consumerPost.identifiers.has(top)) handles.push(top);
    }
  }
  if (handles.length === 0) return false;

  // For members, the leaf must be referenced too (no type inference: name match on the attribute).
  const probe = parts.length > 1 ? leaf : (handles[0] as string);
  const used = parts.length > 1 ? consumerPost.identifiers.has(leaf) : handles.some((h) => countOf(consumerPost, h) > (sameFile ? 1 : 0));
  if (!used) return false;
  if (!opts.addedReferencesOnly) return true;
  if (parts.length > 1) return addedReference(consumerBase, consumerPost, probe);
  return handles.some((h) => addedReference(consumerBase, consumerPost, h));
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

async function getFileContentAtRef(git: SimpleGit, ref: string, filePath: string): Promise<string | null> {
  try {
    return await git.raw(['show', `${ref}:${filePath}`]);
  } catch {
    return null;
  }
}

/**
 * Read many `<ref>:<path>` blobs through one `git cat-file --batch` process:
 * one spawn instead of one per file, since process creation dominates on Windows.
 */
export function readBlobs(cwd: string, specs: string[]): Promise<(string | null)[]> {
  return new Promise((resolve, reject) => {
    if (specs.length === 0) {
      resolve([]);
      return;
    }
    const child = spawnProcess('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file exited with ${String(code)}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const out: (string | null)[] = [];
      let pos = 0;
      for (let i = 0; i < specs.length; i += 1) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) {
          out.push(null);
          continue;
        }
        const header = buf.subarray(pos, nl).toString('utf8');
        pos = nl + 1;
        const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!m) {
          out.push(null); // "<spec> missing"
          continue;
        }
        const size = Number(m[2]);
        out.push(m[1] === 'blob' ? buf.subarray(pos, pos + size).toString('utf8') : null);
        pos += size + 1;
      }
      resolve(out);
    });
    child.stdin.end(specs.map((s) => `${s}\n`).join(''));
  });
}

interface FilePair {
  base: FileAstSummary | null;
  branch: FileAstSummary | null;
}

/**
 * Predict cross-file and intra-file semantic hazards between two concurrent agent branches.
 * Inspects modified contracts (functions, methods, types, interfaces, enums, classes)
 * against the other agent's references.
 *
 * `options` defaults to LEGACY_SEMANTIC for API compatibility; `fleet check`
 * passes PRECISE_SEMANTIC.
 */
export async function predictSemanticConflicts(
  git: SimpleGit,
  agentA: { name: string; branch: string },
  agentB: { name: string; branch: string },
  options: SemanticOptions = {},
  io: { cwd?: string } = {},
): Promise<SemanticPrediction> {
  const opts: Required<SemanticOptions> = { ...LEGACY_SEMANTIC, ...options };
  const startTime = process.hrtime.bigint();
  const hazards: SemanticHazard[] = [];
  const seen = new Set<string>();

  let mergeBase = '';
  try {
    mergeBase = (await git.raw(['merge-base', agentA.branch, agentB.branch])).trim();
  } catch {
    return { hazards: [], hasHazards: false, durationMs: 0 };
  }

  const diffA = (await git.raw(['diff', '--name-only', `${mergeBase}..${agentA.branch}`])).trim().split('\n').filter(Boolean);
  const diffB = (await git.raw(['diff', '--name-only', `${mergeBase}..${agentB.branch}`])).trim().split('\n').filter(Boolean);
  const filesA = diffA.filter(isSemanticFile);
  const filesB = diffB.filter(isSemanticFile);
  if (filesA.length === 0 || filesB.length === 0) {
    return { hazards: [], hasHazards: false, durationMs: elapsed(startTime) };
  }

  // Prefetch every blob in one batch when we know the repo directory.
  const prefetched = new Map<string, string | null>();
  if (io.cwd) {
    const specs = [
      ...new Set([
        ...filesA.flatMap((f) => [`${mergeBase}:${f}`, `${agentA.branch}:${f}`]),
        ...filesB.flatMap((f) => [`${mergeBase}:${f}`, `${agentB.branch}:${f}`]),
      ]),
    ];
    const blobs = await readBlobs(io.cwd, specs);
    specs.forEach((s, i) => prefetched.set(s, blobs[i] ?? null));
  }
  const parsed = new Map<string, FileAstSummary | null>();
  async function at(ref: string, f: string): Promise<FileAstSummary | null> {
    const key = `${ref}:${f}`;
    if (parsed.has(key)) return parsed.get(key) ?? null;
    const content = prefetched.has(key) ? (prefetched.get(key) ?? null) : await getFileContentAtRef(git, ref, f);
    const s = content === null ? null : summarize(f, content);
    parsed.set(key, s);
    return s;
  }
  async function analyze(branch: string, files: string[]): Promise<Map<string, FilePair>> {
    const m = new Map<string, FilePair>();
    for (const f of files) m.set(f, { base: await at(mergeBase, f), branch: await at(branch, f) });
    return m;
  }
  const summariesA = await analyze(agentA.branch, filesA);
  const summariesB = await analyze(agentB.branch, filesB);

  function push(h: SemanticHazard) {
    const key = `${h.type}|${h.symbol}|${h.providerFile}|${h.consumerFile}|${h.providerAgent}`;
    if (seen.has(key)) return;
    seen.add(key);
    hazards.push(h);
  }

  /** Changed or deleted symbols in a provider's file. */
  function changedSymbols(pair: FilePair): { sym: SymbolInfo; deleted: boolean; reason: string; post?: SymbolInfo }[] {
    if (!pair.base) return [];
    if (!pair.branch && !opts.fileDeletions) return [];
    const language = pair.base.language ?? 'typescript';
    const out: { sym: SymbolInfo; deleted: boolean; reason: string; post?: SymbolInfo }[] = [];
    for (const [name, baseSym] of pair.base.exports) {
      // Leading underscore: private by convention in Python.
      if (language === 'python' && opts.compat === 'breaking' && name.split('.').some((p) => p.startsWith('_') && !p.startsWith('__'))) continue;
      const post = pair.branch?.exports.get(name);
      if (!post) {
        out.push({ sym: baseSym, deleted: true, reason: 'removed' });
        continue;
      }
      if (opts.compat === 'any-change') {
        if (baseSym.signature !== post.signature) out.push({ sym: baseSym, deleted: false, reason: `${baseSym.signature} -> ${post.signature}`, post });
      } else {
        const r = breakingReason(baseSym, post, language);
        if (r) out.push({ sym: baseSym, deleted: false, reason: r, post });
      }
    }
    return out;
  }

  function crossCheck(
    providerAgent: string,
    providerSummaries: Map<string, FilePair>,
    consumerAgent: string,
    consumerSummaries: Map<string, FilePair>,
  ) {
    for (const [fileP, pair] of providerSummaries) {
      const changes = changedSymbols(pair);
      if (changes.length === 0) continue;
      for (const [fileC, cPair] of consumerSummaries) {
        if (fileC === fileP || !cPair.branch) continue;
        for (const ch of changes) {
          const refd =
            opts.resolution === 'name' && !opts.addedReferencesOnly
              ? cPair.branch.imports.has(ch.sym.name) ||
                cPair.branch.identifiers.has(ch.sym.name) ||
                cPair.branch.identifiers.has(ch.sym.name.split('.').pop() as string)
              : referencesSymbol({ symbol: ch.sym.name, providerFile: fileP, provider: pair.base as FileAstSummary }, fileC, cPair.base, cPair.branch, opts);
          if (!refd) continue;
          push(
            ch.deleted
              ? {
                  type: 'deleted_symbol',
                  symbol: ch.sym.name,
                  providerFile: fileP,
                  consumerFile: fileC,
                  providerAgent,
                  consumerAgent,
                  details: `Agent ${providerAgent} removed exported ${ch.sym.kind} "${ch.sym.name}" from ${fileP}, which is referenced in ${fileC} by ${consumerAgent}.`,
                }
              : {
                  type: 'breaking_contract_change',
                  symbol: ch.sym.name,
                  providerFile: fileP,
                  consumerFile: fileC,
                  providerAgent,
                  consumerAgent,
                  details: `Agent ${providerAgent} modified contract of ${ch.post?.kind ?? ch.sym.kind} "${ch.sym.name}" in ${fileP} (${ch.reason}), which is used in ${fileC} by ${consumerAgent}.`,
                },
          );
        }
      }
    }
  }

  crossCheck(agentA.name, summariesA, agentB.name, summariesB);
  crossCheck(agentB.name, summariesB, agentA.name, summariesA);

  // Shared files: one agent changed a declaration the other's version uses.
  const sharedFiles = filesA.filter((f) => filesB.includes(f));
  const directions: [string, Map<string, FilePair>, string, Map<string, FilePair>][] = [[agentA.name, summariesA, agentB.name, summariesB]];
  if (opts.bidirectionalIntraFile) directions.push([agentB.name, summariesB, agentA.name, summariesA]);
  for (const sharedFile of sharedFiles) {
    for (const [pAgent, pSums, cAgent, cSums] of directions) {
      const p = pSums.get(sharedFile);
      const c = cSums.get(sharedFile);
      if (!p?.base || !p.branch || !c?.branch) continue;
      if (opts.compat === 'any-change' && opts.resolution === 'name' && !opts.addedReferencesOnly) {
        // Legacy behaviour, kept byte-for-byte for the ablation.
        for (const [symName, baseSym] of p.base.exports) {
          const post = p.branch.exports.get(symName);
          if (post && post.signature !== baseSym.signature && c.branch.identifiers.has(symName)) {
            push(intraHazard(symName, sharedFile, pAgent, cAgent));
          }
        }
        continue;
      }
      for (const ch of changedSymbols(p)) {
        const refd = referencesSymbol({ symbol: ch.sym.name, providerFile: sharedFile, provider: p.base }, sharedFile, c.base, c.branch, opts);
        if (refd) push(intraHazard(ch.sym.name, sharedFile, pAgent, cAgent, ch.reason));
      }
    }
  }

  return { hazards, hasHazards: hazards.length > 0, durationMs: elapsed(startTime) };
}

function intraHazard(symName: string, file: string, pAgent: string, cAgent: string, reason?: string): SemanticHazard {
  return {
    type: 'intra_file_hazard',
    symbol: symName,
    providerFile: file,
    consumerFile: file,
    providerAgent: pAgent,
    consumerAgent: cAgent,
    details: `Agent ${pAgent} altered declaration of "${symName}" in ${file}${reason ? ` (${reason})` : ''}, while concurrent edits in ${cAgent} touch usages of it.`,
  };
}

function elapsed(start: bigint): number {
  return Number((Number(process.hrtime.bigint() - start) / 1e6).toFixed(2));
}
