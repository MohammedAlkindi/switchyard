import type { ToolCategory } from './types.js';

/**
 * Tool name -> spend category.
 *
 * Ported verbatim from the reference implementation this project grew out of
 * (`usage-audit.js`). The buckets are deliberately unchanged: keeping them
 * identical is what makes the differential check in the README meaningful —
 * contextbill's category shares must agree with the reference engine's, and any
 * divergence means the port dropped something.
 *
 * Order matters. `browser` is tested before the generic `mcp__` prefix because
 * browser tools are themselves MCP tools and would otherwise land in
 * `connectors`, hiding the single largest line item on some machines.
 */
const BROWSER = /^mcp__(claude-in-chrome|Claude_Browser)__/;
const FILEOPS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit']);
const SHELL = new Set(['Bash', 'PowerShell']);
const WEB = new Set(['WebSearch', 'WebFetch']);

/** Tools whose use means the session actually produced an artifact. */
const MUTATING = new Set(['Write', 'Edit', 'NotebookEdit']);

export function classify(name: string): ToolCategory {
  if (BROWSER.test(name)) return 'browser';
  if (FILEOPS.has(name)) return 'files';
  if (SHELL.has(name)) return 'shell';
  if (WEB.has(name)) return 'web';
  if (name === 'Agent' || name === 'Task') return 'subagents';
  if (name.startsWith('mcp__')) return 'connectors';
  return 'other';
}

/**
 * The MCP server a tool belongs to, or null if it is not an MCP tool.
 *
 * Tool names arrive as `mcp__<server>__<tool>`, so the server is recoverable
 * from the call itself. That matters because a transcript records nothing about
 * which servers were *loaded* — there is no tool catalog, no `mcp_servers`, no
 * system prompt in the file, only the calls that happened. So this can attribute
 * what a connector cost when it was used, and can never see one that was loaded
 * and never called. `report.ts` says so rather than implying the list is
 * complete.
 *
 * Server names are not always human-readable: a claude.ai connector is a UUID.
 * That is passed through unchanged rather than guessed at.
 */
export function mcpServer(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const end = rest.indexOf('__');
  const server = end === -1 ? rest : rest.slice(0, end);
  return server.length > 0 ? server : null;
}

/**
 * Did this tool call write something to disk?
 *
 * Note this is narrower than "had a side effect" — a `Bash` call can absolutely
 * write a file, and this deliberately does not count it. The signal is used only
 * to flag sessions for human review, so a false *negative* (a Bash-only session
 * flagged as writing nothing) is cheap, while a false positive would hide a real
 * finding. See `waste.ts` for how the flag is framed in the report.
 */
export function isMutatingTool(name: string): boolean {
  return MUTATING.has(name);
}
