import type { SimpleGit } from 'simple-git';
import ts from 'typescript';

export interface ExportedSymbol {
  name: string;
  kind: 'function' | 'interface' | 'type' | 'enum' | 'class' | 'variable';
  signature: string;
  lineStart: number;
  lineEnd: number;
}

export interface FileAstSummary {
  exports: Map<string, ExportedSymbol>;
  imports: Map<string, string>; // symbolName -> moduleSpecifier
  identifiers: Set<string>;
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
 * Fast in-memory AST parser that extracts exported declarations and symbol usages
 * from a TypeScript or JavaScript source string in sub-millisecond time.
 */
export function parseSourceAst(fileName: string, content: string): FileAstSummary {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const exports = new Map<string, ExportedSymbol>();
  const imports = new Map<string, string>();
  const identifiers = new Set<string>();

  function isExported(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  }

  function getLineRange(node: ts.Node): { start: number; end: number } {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { start, end };
  }

  function visit(node: ts.Node) {
    // Record identifier usages
    if (ts.isIdentifier(node)) {
      identifiers.add(node.text);
    }

    // Record imports
    if (ts.isImportDeclaration(node) && node.importClause && node.moduleSpecifier) {
      const modulePath = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
      if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const spec of node.importClause.namedBindings.elements) {
          imports.set(spec.name.text, modulePath);
        }
      }
      if (node.importClause.name) {
        imports.set(node.importClause.name.text, modulePath);
      }
    }

    // Record exports
    if (isExported(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const { start, end } = getLineRange(node);
        const params = node.parameters.map((p) => {
          const typeStr = p.type ? p.type.getText(sourceFile) : 'any';
          return `${p.name.getText(sourceFile)}: ${typeStr}`;
        });
        const returnType = node.type ? node.type.getText(sourceFile) : 'void';
        const signature = `(${params.join(', ')}): ${returnType}`;
        exports.set(node.name.text, {
          name: node.name.text,
          kind: 'function',
          signature,
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
          lineStart: start,
          lineEnd: end,
        });
      } else if (ts.isTypeAliasDeclaration(node)) {
        const { start, end } = getLineRange(node);
        const typeStr = node.type.getText(sourceFile).trim();
        exports.set(node.name.text, {
          name: node.name.text,
          kind: 'type',
          signature: typeStr,
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
          lineStart: start,
          lineEnd: end,
        });
      } else if (ts.isVariableStatement(node)) {
        const { start, end } = getLineRange(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const typeStr = decl.type ? decl.type.getText(sourceFile) : decl.initializer ? decl.initializer.getText(sourceFile) : 'any';
            exports.set(decl.name.text, {
              name: decl.name.text,
              kind: 'variable',
              signature: typeStr,
              lineStart: start,
              lineEnd: end,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { exports, imports, identifiers };
}

/**
 * Read the content of a file at a specific git ref/commit without checking it out.
 */
async function getFileContentAtRef(git: SimpleGit, ref: string, filePath: string): Promise<string | null> {
  try {
    const content = await git.raw(['show', `${ref}:${filePath}`]);
    return content;
  } catch {
    return null; // file didn't exist at this ref
  }
}

/**
 * Predict cross-file and intra-file semantic hazards between two concurrent agent branches.
 * Inspects modified AST contracts (functions, types, interfaces, enums) against consumer call sites.
 */
export async function predictSemanticConflicts(
  git: SimpleGit,
  agentA: { name: string; branch: string },
  agentB: { name: string; branch: string },
): Promise<SemanticPrediction> {
  const startTime = process.hrtime.bigint();
  const hazards: SemanticHazard[] = [];

  // Find common merge base
  let mergeBase = '';
  try {
    mergeBase = (await git.raw(['merge-base', agentA.branch, agentB.branch])).trim();
  } catch {
    return { hazards: [], hasHazards: false, durationMs: 0 };
  }

  // Get changed files for both branches vs merge base
  const diffA = (await git.raw(['diff', '--name-only', `${mergeBase}..${agentA.branch}`])).trim().split('\n').filter(Boolean);
  const diffB = (await git.raw(['diff', '--name-only', `${mergeBase}..${agentB.branch}`])).trim().split('\n').filter(Boolean);

  const isCodeFile = (f: string) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f);
  const filesA = diffA.filter(isCodeFile);
  const filesB = diffB.filter(isCodeFile);

  // Helper to collect AST summaries
  async function analyzeAgentChanges(
    agentName: string,
    agentBranch: string,
    changedFiles: string[],
  ): Promise<Map<string, { baseAst: FileAstSummary | null; branchAst: FileAstSummary | null }>> {
    const fileSummaries = new Map<string, { baseAst: FileAstSummary | null; branchAst: FileAstSummary | null }>();
    for (const f of changedFiles) {
      const baseContent = await getFileContentAtRef(git, mergeBase, f);
      const branchContent = await getFileContentAtRef(git, agentBranch, f);

      const baseAst = baseContent !== null ? parseSourceAst(f, baseContent) : null;
      const branchAst = branchContent !== null ? parseSourceAst(f, branchContent) : null;
      fileSummaries.set(f, { baseAst, branchAst });
    }
    return fileSummaries;
  }

  const summariesA = await analyzeAgentChanges(agentA.name, agentA.branch, filesA);
  const summariesB = await analyzeAgentChanges(agentB.name, agentB.branch, filesB);

  // Cross-check: Did Agent A mutate/delete an exported contract that Agent B touches/imports?
  function checkCrossContracts(
    sourceAgent: string,
    sourceSummaries: Map<string, { baseAst: FileAstSummary | null; branchAst: FileAstSummary | null }>,
    targetAgent: string,
    targetSummaries: Map<string, { baseAst: FileAstSummary | null; branchAst: FileAstSummary | null }>,
  ) {
    for (const [fileA, summaryA] of sourceSummaries.entries()) {
      if (!summaryA.baseAst || !summaryA.branchAst) continue;

      // Find deleted or mutated exported symbols in fileA
      for (const [symName, baseSym] of summaryA.baseAst.exports.entries()) {
        const branchSym = summaryA.branchAst.exports.get(symName);
        if (!branchSym) {
          // Symbol was deleted or unexported!
          for (const [fileB, summaryB] of targetSummaries.entries()) {
            if (fileA === fileB) continue;
            if (summaryB.branchAst && (summaryB.branchAst.imports.has(symName) || summaryB.branchAst.identifiers.has(symName))) {
              hazards.push({
                type: 'deleted_symbol',
                symbol: symName,
                providerFile: fileA,
                consumerFile: fileB,
                providerAgent: sourceAgent,
                consumerAgent: targetAgent,
                details: `Agent ${sourceAgent} removed exported ${baseSym.kind} "${symName}" from ${fileA}, which is referenced in ${fileB} by ${targetAgent}.`,
              });
            }
          }
        } else if (baseSym.signature !== branchSym.signature) {
          // Signature or structure was modified!
          for (const [fileB, summaryB] of targetSummaries.entries()) {
            if (fileA === fileB) continue;
            if (summaryB.branchAst && (summaryB.branchAst.imports.has(symName) || summaryB.branchAst.identifiers.has(symName))) {
              hazards.push({
                type: 'breaking_contract_change',
                symbol: symName,
                providerFile: fileA,
                consumerFile: fileB,
                providerAgent: sourceAgent,
                consumerAgent: targetAgent,
                details: `Agent ${sourceAgent} modified contract of ${branchSym.kind} "${symName}" in ${fileA} (${baseSym.signature} -> ${branchSym.signature}), which is used in ${fileB} by ${targetAgent}.`,
              });
            }
          }
        }
      }
    }
  }

  // Cross-check in both directions
  checkCrossContracts(agentA.name, summariesA, agentB.name, summariesB);
  checkCrossContracts(agentB.name, summariesB, agentA.name, summariesA);

  // Intra-file check for shared files where line edits were non-overlapping
  const sharedFiles = filesA.filter((f) => filesB.includes(f));
  for (const sharedFile of sharedFiles) {
    const sumA = summariesA.get(sharedFile);
    const sumB = summariesB.get(sharedFile);
    if (!sumA?.baseAst || !sumA?.branchAst || !sumB?.branchAst) continue;

    // Check if one agent changed a declaration that the other agent's diff touches
    for (const [symName, baseSym] of sumA.baseAst.exports.entries()) {
      const branchSymA = sumA.branchAst.exports.get(symName);
      if (branchSymA && branchSymA.signature !== baseSym.signature) {
        if (sumB.branchAst.identifiers.has(symName)) {
          hazards.push({
            type: 'intra_file_hazard',
            symbol: symName,
            providerFile: sharedFile,
            consumerFile: sharedFile,
            providerAgent: agentA.name,
            consumerAgent: agentB.name,
            details: `Agent ${agentA.name} altered declaration of "${symName}" in ${sharedFile}, while concurrent edits in ${agentB.name} touch usages of it.`,
          });
        }
      }
    }
  }

  const endTime = process.hrtime.bigint();
  const durationMs = Number(endTime - startTime) / 1e6;

  return {
    hazards,
    hasHazards: hazards.length > 0,
    durationMs: Number(durationMs.toFixed(2)),
  };
}
