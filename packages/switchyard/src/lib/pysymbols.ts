/**
 * Dependency-free Python symbol extractor for the semantic conflict filter.
 *
 * It is not a Python parser. It masks strings and comments, joins logical
 * lines (open brackets, backslash continuations), and reads the declarations
 * a pre-merge gate cares about: top-level and class-level `def`/`async def`,
 * `class`, module-level assignments, and imports. That covers the contract
 * surface (what other code can call or import) without pulling in a grammar
 * runtime, which would be a new dependency for one language.
 *
 * Known blind spots: names created dynamically (`globals()[...]`, `setattr`),
 * `__all__` manipulation, and anything inside `exec` strings.
 */

import type { FileAstSummary, Param, SymbolInfo } from './semantic.js';

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/**
 * Replace the bodies of string literals and comments with spaces, keeping
 * every newline so line numbers survive. Quotes are kept so `''` stays a token.
 */
export function maskPython(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === '#') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      out.push(q);
      i += q.length;
      while (i < n) {
        if (src[i] === '\\') {
          out.push(' ', src[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
          continue;
        }
        if (src.startsWith(q, i)) {
          out.push(q);
          i += q.length;
          break;
        }
        if (!triple && src[i] === '\n') break; // unterminated: stop at EOL
        out.push(src[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

interface LogicalLine {
  text: string; // masked, physical lines joined with spaces
  indent: number;
  line: number; // 1-based first physical line
  endLine: number;
}

function logicalLines(masked: string): LogicalLine[] {
  const physical = masked.split('\n');
  const result: LogicalLine[] = [];
  let buf = '';
  let depth = 0;
  let start = 0;
  let indent = 0;
  for (let k = 0; k < physical.length; k += 1) {
    const raw = physical[k] as string;
    if (buf === '') {
      if (raw.trim() === '') continue;
      start = k;
      indent = raw.length - raw.trimStart().length;
    }
    let piece = raw;
    const continued = /\\\s*$/.test(piece);
    if (continued) piece = piece.replace(/\\\s*$/, '');
    for (const ch of piece) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth -= 1;
    }
    buf += (buf === '' ? '' : ' ') + piece.trim();
    if (depth === 0 && !continued) {
      result.push({ text: buf, indent, line: start + 1, endLine: k + 1 });
      buf = '';
    }
  }
  if (buf !== '') result.push({ text: buf, indent, line: start + 1, endLine: physical.length });
  return result;
}

/** Split on commas at bracket depth 0. */
export function splitTopLevel(s: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Index of the bracket that closes the one opened at `open`. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k += 1) {
    if (s[k] === '(' || s[k] === '[' || s[k] === '{') depth += 1;
    else if (s[k] === ')' || s[k] === ']' || s[k] === '}') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

export function parsePythonParams(paramText: string): Param[] {
  const params: Param[] = [];
  let kwOnly = false;
  const raw = splitTopLevel(paramText);
  const slashAt = raw.indexOf('/');
  raw.forEach((part, idx) => {
    if (part === '/') return;
    if (part === '*') {
      kwOnly = true;
      return;
    }
    if (part.startsWith('**')) {
      params.push({ name: part.slice(2).split(':')[0]!.trim(), kind: 'varkw', optional: true, type: '' });
      return;
    }
    if (part.startsWith('*')) {
      params.push({ name: part.slice(1).split(':')[0]!.trim(), kind: 'varargs', optional: true, type: '' });
      kwOnly = true;
      return;
    }
    const eq = splitTopLevel(part, '=');
    const head = eq[0] ?? part;
    const [nameRaw, ...ann] = head.split(':');
    params.push({
      name: (nameRaw ?? '').trim(),
      kind: kwOnly ? 'keyword' : slashAt >= 0 && idx < slashAt ? 'positional' : 'normal',
      optional: eq.length > 1,
      type: ann.join(':').trim(),
    });
  });
  return params;
}

function moduleNameFor(filePath: string): string {
  const noExt = filePath.replace(/\\/g, '/').replace(/\.pyi?$/, '');
  return noExt.endsWith('/__init__') ? noExt.slice(0, -'/__init__'.length) : noExt;
}

/**
 * Extract the contract surface of a Python module. Members are recorded
 * twice: as `Class.member` symbols (so a changed method is its own hazard)
 * and in the class symbol's `members` list.
 */
export function parsePythonSource(fileName: string, content: string): FileAstSummary {
  const masked = maskPython(content);
  const lines = logicalLines(masked);
  const exports = new Map<string, SymbolInfo>();
  const imports = new Map<string, string>();
  const importNames = new Map<string, string>();
  const importedModules = new Map<string, string>();
  const identifierCounts = new Map<string, number>();

  const identifierLines = new Map<string, number[]>();
  masked.split('\n').forEach((lineText, i) => {
    for (const m of lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const id = m[0];
      if (KEYWORDS.has(id)) continue;
      identifierCounts.set(id, (identifierCounts.get(id) ?? 0) + 1);
      identifierLines.set(id, [...(identifierLines.get(id) ?? []), i + 1]);
    }
  });

  // Scope stack: which class (if any) owns the current indentation level.
  const scopes: { indent: number; kind: 'class' | 'def'; name: string }[] = [];
  let decorators: string[] = [];

  lines.forEach((ll, idx) => {
    while (scopes.length > 0 && ll.indent <= (scopes[scopes.length - 1] as { indent: number }).indent) scopes.pop();
    const top = scopes[scopes.length - 1];
    const atModule = scopes.length === 0;
    const inClassBody = top?.kind === 'class' && scopes.every((s) => s.kind === 'class');
    const text = ll.text;
    // Block end = line before the next logical line at this indent or shallower.
    let endLine = ll.endLine;
    for (let k = idx + 1; k < lines.length; k += 1) {
      const next = lines[k] as LogicalLine;
      if (next.indent <= ll.indent) break;
      endLine = next.endLine;
    }

    if (text.startsWith('@')) {
      decorators.push(text.slice(1).split('(')[0]!.trim());
      return;
    }

    const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(text);
    if (def) {
      const name = def[1] as string;
      const open = text.indexOf('(', def.index);
      const close = matchParen(text, open);
      const paramText = close > open ? text.slice(open + 1, close) : '';
      const after = close > 0 ? text.slice(close + 1) : '';
      const ret = /->\s*(.+?)\s*:\s*\S*$/.exec(after)?.[1] ?? /->\s*(.+?):/.exec(after)?.[1] ?? '';
      const params = parsePythonParams(paramText);
      const decos = decorators.filter((d) => /^(property|staticmethod|classmethod|\w+\.setter|overload|abstractmethod)$/.test(d));
      const qual = atModule ? name : inClassBody ? `${scopes.map((s) => s.name).join('.')}.${name}` : undefined;
      if (qual) {
        if (inClassBody && decos.length === 0 && params[0] && (params[0].name === 'self' || params[0].name === 'cls')) {
          params.shift();
        } else if (inClassBody && decos.includes('classmethod') && params[0]) {
          params.shift();
        }
        const sig = `${decos.map((d) => `@${d} `).join('')}(${paramText.replace(/\s+/g, ' ').replace(/,\s*$/, '').trim()})${ret ? ` -> ${ret.trim()}` : ''}`;
        // `@foo.setter` re-declares a property: keep the first (getter) entry.
        if (!(exports.has(qual) && decos.some((d) => d.endsWith('.setter')))) {
          exports.set(qual, {
            name: qual,
            kind: inClassBody ? 'method' : 'function',
            signature: sig,
            params: decos.includes('property') ? undefined : params,
            decorators: decos,
            returnType: ret.trim(),
            lineStart: ll.line,
            lineEnd: endLine,
          });
          if (inClassBody && top) exports.get(top.name)?.members?.push(name);
        }
      }
      decorators = [];
      scopes.push({ indent: ll.indent, kind: 'def', name });
      return;
    }

    const cls = /^class\s+([A-Za-z_]\w*)\s*(\(([^]*)\))?\s*:/.exec(text);
    if (cls) {
      const name = cls[1] as string;
      const qual = atModule ? name : inClassBody ? `${scopes.map((s) => s.name).join('.')}.${name}` : undefined;
      if (qual) {
        exports.set(qual, {
          name: qual,
          kind: 'class',
          signature: `(${(cls[3] ?? '').replace(/\s+/g, ' ').trim()})`,
          members: [],
          lineStart: ll.line,
          lineEnd: endLine,
        });
      }
      decorators = [];
      scopes.push({ indent: ll.indent, kind: 'class', name });
      return;
    }
    decorators = [];

    if (atModule) {
      const fromImp = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(text);
      if (fromImp) {
        const mod = fromImp[1] as string;
        const names = (fromImp[2] as string).replace(/[()]/g, '');
        for (const part of splitTopLevel(names)) {
          const [orig, alias] = part.split(/\s+as\s+/).map((x) => x.trim());
          if (!orig || orig === '*') continue;
          imports.set(alias ?? orig, mod);
          importNames.set(alias ?? orig, orig);
        }
        return;
      }
      const imp = /^import\s+(.+)$/.exec(text);
      if (imp) {
        for (const part of splitTopLevel(imp[1] as string)) {
          const [mod, alias] = part.split(/\s+as\s+/).map((x) => x.trim());
          if (!mod) continue;
          importedModules.set(alias ?? (mod.split('.')[0] as string), alias ? mod : (mod.split('.')[0] as string));
          if (!alias) importedModules.set(mod, mod);
        }
        return;
      }
      const assign = /^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(=(?!=)|$)/.exec(text);
      if (assign && !/^(if|for|while|with|try|elif|else|except|finally|return|raise|del|assert|global|nonlocal|pass|print)\b/.test(text)) {
        const name = assign[1] as string;
        if (!exports.has(name)) {
          exports.set(name, {
            name,
            kind: 'variable',
            signature: (assign[2] ?? '').trim(),
            lineStart: ll.line,
            lineEnd: endLine,
          });
        }
      }
    } else if (inClassBody && top) {
      const attr = /^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(=(?!=)|$)/.exec(text);
      if (attr) {
        const qual = `${scopes.map((s) => s.name).join('.')}.${attr[1] as string}`;
        if (!exports.has(qual)) {
          exports.set(qual, { name: qual, kind: 'variable', signature: (attr[2] ?? '').trim(), lineStart: ll.line, lineEnd: endLine });
          exports.get(top.name)?.members?.push(attr[1] as string);
        }
      }
    }
  });

  return {
    language: 'python',
    module: moduleNameFor(fileName),
    exports,
    imports,
    importNames,
    importedModules,
    identifiers: new Set(identifierCounts.keys()),
    identifierCounts,
    identifierLines,
    sourceLines: content.split('\n'),
  };
}
