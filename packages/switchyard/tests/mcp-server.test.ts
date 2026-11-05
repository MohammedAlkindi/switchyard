import { execFile, spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../src/commands/spawn.js';
import { PROTOCOL_VERSION } from '../src/lib/mcp.js';
import { commitFile, makeTempRepo, worktreePath } from './helpers.js';
import type { TempRepo } from './helpers.js';

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

interface JsonRpcReply {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A minimal MCP client speaking newline-delimited JSON-RPC to a real
 * `fleet mcp` subprocess. The point of these tests is that the bytes on the
 * wire are right, so nothing here is shared with the server implementation.
 */
class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (reply: JsonRpcReply) => void>();
  private readonly lines: string[] = [];
  private buffer = '';
  private nextId = 1;
  readonly stderr: string[] = [];

  constructor(cwd: string) {
    this.child = spawnProcess(process.execPath, [CLI, 'mcp'], { cwd });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim() !== '') this.deliver(line);
        newline = this.buffer.indexOf('\n');
      }
    });
  }

  private deliver(line: string): void {
    this.lines.push(line);
    const reply = JSON.parse(line) as JsonRpcReply;
    const resolve = this.pending.get(reply.id);
    if (resolve !== undefined) {
      this.pending.delete(reply.id);
      resolve(reply);
    }
  }

  /** Every response line the server has written so far, raw. */
  get rawLines(): string[] {
    return [...this.lines];
  }

  request(method: string, params?: unknown): Promise<JsonRpcReply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20_000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  /** Complete the handshake exactly as a real client does. */
  async handshake(): Promise<JsonRpcReply> {
    const reply = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'switchyard-test-client', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return reply;
  }

  /** Call a tool and return its parsed JSON payload. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const reply = await this.request('tools/call', { name, arguments: args });
    const result = reply.result as { content: { text: string }[]; isError?: boolean } | undefined;
    if (result === undefined) throw new Error(`tool ${name} returned an error: ${reply.error?.message}`);
    const block = result.content[0];
    if (block === undefined) throw new Error(`tool ${name} returned no content`);
    return JSON.parse(block.text) as unknown;
  }

  /** Close stdin and wait for the server to exit on its own. */
  close(): Promise<number | null> {
    return new Promise((resolve) => {
      this.child.on('exit', (code) => resolve(code));
      this.child.stdin.end();
    });
  }
}

let repo: TempRepo;
let client: McpClient | undefined;

beforeEach(async () => {
  // Silences the in-process `spawn()` calls used to build fixtures. The server
  // under test is a real subprocess and is unaffected by this.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  repo = await makeTempRepo();
});

afterEach(async () => {
  if (client !== undefined) await client.close();
  client = undefined;
  vi.restoreAllMocks();
  repo.cleanup();
});

describe('fleet mcp over stdio', () => {
  it('completes the handshake with a protocol version, capabilities, and instructions', async () => {
    client = new McpClient(repo.root);
    const reply = await client.handshake();

    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'switchyard' },
    });
    // The "humans provision and merge" contract has to reach the model even
    // when the shipped skill was never installed.
    const { instructions } = reply.result as { instructions: string };
    expect(instructions).toContain('read-only');
    expect(instructions).toContain('fleet spawn');
  });

  it('negotiates down to a revision it supports rather than erroring', async () => {
    client = new McpClient(repo.root);
    const reply = await client.request('initialize', { protocolVersion: '1999-01-01' });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  });

  it('lists exactly the four read-only tools', async () => {
    client = new McpClient(repo.root);
    await client.handshake();
    const reply = await client.request('tools/list');
    const { tools } = reply.result as { tools: { name: string; inputSchema: unknown }[] };

    expect(tools.map((t) => t.name).sort()).toEqual([
      'fleet_check',
      'fleet_list',
      'fleet_lock_status',
      'fleet_status',
    ]);
    // No mutating tool may appear: spawning and merging are human actions.
    for (const forbidden of ['fleet_spawn', 'fleet_merge', 'fleet_remove', 'fleet_clean']) {
      expect(tools.map((t) => t.name)).not.toContain(forbidden);
    }
  });

  it('serves real fleet data through all four tools', async () => {
    await spawn('alice', { cwd: repo.root });
    await spawn('bob', { cwd: repo.root });
    await commitFile(worktreePath(repo.root, 'alice'), 'shared.txt', 'alice\n', 'feat: alice');
    await commitFile(worktreePath(repo.root, 'bob'), 'shared.txt', 'bob\n', 'feat: bob');

    client = new McpClient(repo.root);
    await client.handshake();

    const listings = (await client.callTool('fleet_list')) as { name: string }[];
    expect(listings.map((l) => l.name).sort()).toEqual(['alice', 'bob']);

    const status = (await client.callTool('fleet_status', { agent: 'alice' })) as {
      record: { name: string; branch: string };
      ahead: number;
    };
    expect(status.record).toMatchObject({ name: 'alice', branch: 'fleet/alice' });
    expect(status.ahead).toBe(1);

    const check = (await client.callTool('fleet_check')) as {
      collisions: { file: string; agents: string[] }[];
      agentsChecked: number;
    };
    expect(check.agentsChecked).toBe(2);
    expect(check.collisions.map((c) => c.file)).toContain('shared.txt');

    const lock = (await client.callTool('fleet_lock_status')) as { state: string };
    expect(lock.state).toBe('none');
  });

  it('never creates .fleet/lock — the server only reads', async () => {
    await spawn('alice', { cwd: repo.root });
    const lockFile = path.join(repo.root, '.fleet', 'lock');

    client = new McpClient(repo.root);
    await client.handshake();
    expect(existsSync(lockFile)).toBe(false);

    for (const tool of ['fleet_list', 'fleet_check', 'fleet_lock_status']) {
      await client.callTool(tool);
      expect(existsSync(lockFile), `${tool} took the mutation lock`).toBe(false);
    }
    await client.callTool('fleet_status', { agent: 'alice' });
    expect(existsSync(lockFile)).toBe(false);
  });

  it('re-reads state per call, so agents spawned underneath it appear', async () => {
    client = new McpClient(repo.root);
    await client.handshake();
    expect(await client.callTool('fleet_list')).toEqual([]);

    // A human spawns an agent in another terminal while the server is live.
    await execFileP(process.execPath, [CLI, 'spawn', 'carol'], { cwd: repo.root });

    const listings = (await client.callTool('fleet_list')) as { name: string }[];
    expect(listings.map((l) => l.name)).toEqual(['carol']);
  });

  it('reports a missing agent as an actionable tool error, not a crash', async () => {
    client = new McpClient(repo.root);
    await client.handshake();

    const reply = await client.request('tools/call', {
      name: 'fleet_status',
      arguments: { agent: 'ghost' },
    });
    const result = reply.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ghost');

    // The session survives: the next call still works.
    expect(await client.callTool('fleet_list')).toEqual([]);
  });

  it('rejects a missing agent argument with guidance', async () => {
    client = new McpClient(repo.root);
    await client.handshake();
    const reply = await client.request('tools/call', { name: 'fleet_status', arguments: {} });
    const result = reply.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('fleet_list');
  });

  it('answers an unknown tool with a protocol error', async () => {
    client = new McpClient(repo.root);
    await client.handshake();
    const reply = await client.request('tools/call', { name: 'fleet_spawn', arguments: {} });
    expect(reply.result).toBeUndefined();
    expect(reply.error?.message).toBe('Unknown tool: fleet_spawn');
  });

  it('writes nothing to stdout but protocol messages', async () => {
    await spawn('alice', { cwd: repo.root });
    client = new McpClient(repo.root);
    await client.handshake();
    await client.callTool('fleet_list');
    await client.callTool('fleet_check');

    // Every line must parse as JSON-RPC; a stray console.log would not.
    for (const line of client.rawLines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    // The notification we sent must not have drawn a reply.
    expect(client.rawLines).toHaveLength(3);
  });

  it('exits cleanly when stdin closes', async () => {
    client = new McpClient(repo.root);
    await client.handshake();
    const code = await client.close();
    client = undefined;
    expect(code).toBe(0);
  });
});
