import { readFileSync } from 'node:fs';
import { FleetError } from '../lib/errors.js';
import { getMainRepoRoot } from '../lib/git.js';
import { serveJsonRpc } from '../lib/jsonrpc.js';
import { lockStatus } from '../lib/lock.js';
import { NO_ARGUMENTS, createMcpHandler } from '../lib/mcp.js';
import type { McpTool } from '../lib/mcp.js';
import { collectCheck } from './check.js';
import { collectListings } from './list.js';
import { collectStatus } from './status.js';

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

export interface McpOptions {
  cwd?: string;
}

/**
 * Guidance sent to the model at handshake time, so it arrives even when the
 * shipped skill was never installed.
 *
 * The "humans provision and merge" sentence is the load-bearing one. An agent
 * that goes looking for a spawn tool, fails to find it, and falls back to raw
 * `git worktree` has reproduced exactly the uncoordinated behavior Switchyard
 * exists to prevent.
 */
const INSTRUCTIONS = [
  'Switchyard gives each AI agent its own git worktree and branch so several',
  'agents can work in one repository without colliding.',
  '',
  'Work only inside your own worktree, never the main checkout — the whole',
  'isolation guarantee rests on that. Call fleet_list first to find it.',
  '',
  'Call fleet_check before you start editing a file, not just before merging.',
  'A "conflicts" verdict means stop and coordinate. An "uncommitted" verdict',
  'means another agent has unsaved work there that merge simulation could not',
  'see. A clean overlap is informational.',
  '',
  'These tools are read-only by design. Spawning agents, merging, and removing',
  'worktrees are human actions in this release — there are no tools for them.',
  'Ask for `fleet spawn <name>` rather than creating a worktree yourself.',
].join('\n');

/** Reject a missing or non-string agent name with a message the model can act on. */
function requireAgent(args: Record<string, unknown>): string {
  const agent = args.agent;
  if (typeof agent !== 'string' || agent.trim() === '') {
    throw new FleetError('The "agent" argument is required. Call fleet_list for active agents.');
  }
  return agent;
}

/** The four read-only tools. Every handler re-reads state; caching would be a bug. */
export function buildTools(cwd: string): McpTool[] {
  return [
    {
      name: 'fleet_list',
      title: 'List fleet agents',
      description:
        'List every active agent in this repository with its branch, base branch, ' +
        'worktree path, ahead/behind counts, uncommitted file count, and last activity. ' +
        'Call this first to find your own worktree and see who else is working here.',
      inputSchema: NO_ARGUMENTS,
      run: () => collectListings({ cwd }),
    },
    {
      name: 'fleet_status',
      title: 'Inspect one agent',
      description:
        "Detailed view of one agent: its record, how far ahead/behind its base branch it is, " +
        'its uncommitted files, and a diffstat of its committed work against that base.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Name of the agent to inspect, as reported by fleet_list.',
          },
        },
        required: ['agent'],
        additionalProperties: false,
      },
      run: (args) => collectStatus(requireAgent(args), { cwd }),
    },
    {
      name: 'fleet_check',
      title: 'Check for collisions',
      description:
        'Report files touched by more than one agent. By default each overlap is run ' +
        'through a merge simulation, so a shared file is only a collision when it would ' +
        'actually conflict ("conflicts") or when another agent has uncommitted work in it ' +
        '("uncommitted"). Call this before editing a file and again before asking for a merge.',
      inputSchema: {
        type: 'object',
        properties: {
          lines: {
            type: 'boolean',
            description:
              'Only count files whose edited line ranges actually overlap, and report ' +
              'same-file edits on disjoint lines separately.',
          },
          filesOnly: {
            type: 'boolean',
            description:
              'Skip merge simulation and flag any shared file. Coarser, but works on ' +
              'git older than 2.38.',
          },
        },
        additionalProperties: false,
      },
      run: (args) =>
        collectCheck({
          cwd,
          lines: args.lines === true,
          filesOnly: args.filesOnly === true,
        }),
    },
    {
      name: 'fleet_lock_status',
      title: 'Check the mutation lock',
      description:
        'Report whether a fleet command is currently mutating this repository. A "live" ' +
        'lock means a human is mid-spawn, mid-merge, or mid-clean: wait and retry rather ' +
        'than working around it. "stale" means the holder died and `fleet doctor --fix` ' +
        'will clear it. "none" means the repository is idle.',
      inputSchema: NO_ARGUMENTS,
      run: async () => lockStatus(await getMainRepoRoot(cwd)),
    },
  ];
}

/**
 * Serve the four read-only tools over MCP's stdio transport.
 *
 * This command owns stdout as a protocol channel: a single stray write corrupts
 * the JSON-RPC stream and breaks the client session. The tools call the pure
 * collectors (`collectListings`, `collectStatus`, `collectCheck`) rather than
 * the printing commands, which is the actual mechanism. Rerouting `console` on
 * top of that is a net for anything that writes without going through them —
 * stderr is free for logging under this transport.
 */
export async function mcp(options: McpOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  for (const method of ['log', 'info', 'debug', 'warn'] as const) {
    console[method] = (...args: unknown[]) => {
      process.stderr.write(`${args.map(String).join(' ')}\n`);
    };
  }

  const handler = createMcpHandler({
    serverInfo: { name: 'switchyard', title: 'Switchyard', version: pkg.version },
    tools: buildTools(cwd),
    instructions: INSTRUCTIONS,
  });

  await serveJsonRpc(process.stdin, process.stdout, handler);
}
