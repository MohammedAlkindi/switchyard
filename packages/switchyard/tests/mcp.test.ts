import { describe, expect, it } from 'vitest';
import { FleetError } from '../src/lib/errors.js';
import { INVALID_PARAMS, JsonRpcError, METHOD_NOT_FOUND } from '../src/lib/jsonrpc.js';
import {
  COMPATIBLE_PROTOCOL_VERSIONS,
  NO_ARGUMENTS,
  PROTOCOL_VERSION,
  createMcpHandler,
  negotiateVersion,
} from '../src/lib/mcp.js';
import type { McpTool, ToolCallResult } from '../src/lib/mcp.js';

const tools: McpTool[] = [
  {
    name: 'demo_echo',
    title: 'Demo Echo',
    description: 'Return the arguments it was given.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    run: async (args) => ({ echoed: args.value }),
  },
  {
    name: 'demo_expected_failure',
    title: 'Demo Expected Failure',
    description: 'Always throws a FleetError.',
    inputSchema: NO_ARGUMENTS,
    run: async () => {
      throw new FleetError('Unknown agent: ghost. Run `fleet list` to see active agents.');
    },
  },
  {
    name: 'demo_unexpected_failure',
    title: 'Demo Unexpected Failure',
    description: 'Always throws something unexpected.',
    inputSchema: NO_ARGUMENTS,
    run: async () => {
      throw new TypeError('worktree vanished mid-read');
    },
  },
];

const handler = createMcpHandler({
  serverInfo: { name: 'switchyard-test', version: '9.9.9' },
  tools,
  instructions: 'Provisioning is a human action.',
});

/** The text of the single content block a tools/call result carries. */
function firstText(result: unknown): string {
  const block = (result as ToolCallResult).content[0];
  if (block === undefined) throw new Error('tool result carried no content block');
  return block.text;
}

/** Parse the single text block a tools/call result carries. */
function payload(result: unknown): unknown {
  return JSON.parse(firstText(result)) as unknown;
}

describe('initialize handshake', () => {
  it('answers with the protocol version, tool capability, and server info', async () => {
    const result = await handler('initialize', { protocolVersion: PROTOCOL_VERSION });
    expect(result).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'switchyard-test', version: '9.9.9' },
      instructions: 'Provisioning is a human action.',
    });
  });

  it('does not advertise listChanged, because the tool set is fixed', async () => {
    const result = (await handler('initialize', {})) as { capabilities: { tools: object } };
    expect(result.capabilities.tools).not.toHaveProperty('listChanged');
  });

  it('echoes back any revision it is compatible with', async () => {
    for (const version of COMPATIBLE_PROTOCOL_VERSIONS) {
      expect(negotiateVersion(version)).toBe(version);
    }
  });

  it('answers an unsupported revision with its own instead of failing', async () => {
    // The spec is explicit that version mismatch is a negotiation, not an error.
    expect(negotiateVersion('1999-01-01')).toBe(PROTOCOL_VERSION);
    expect(negotiateVersion(undefined)).toBe(PROTOCOL_VERSION);
    expect(negotiateVersion(42)).toBe(PROTOCOL_VERSION);

    const result = await handler('initialize', { protocolVersion: 'not-a-version' });
    expect(result).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  });
});

describe('tools/list', () => {
  it('lists every tool with its wire-visible fields only', async () => {
    const { tools: listed } = (await handler('tools/list', undefined)) as {
      tools: Record<string, unknown>[];
    };
    expect(listed).toHaveLength(3);
    for (const tool of listed) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'inputSchema', 'name', 'title']);
      expect(tool).not.toHaveProperty('run');
    }
  });

  it('gives every tool an object inputSchema, which the spec requires', async () => {
    const { tools: listed } = (await handler('tools/list', undefined)) as {
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    };
    for (const tool of listed) {
      expect(tool.inputSchema, tool.name).toBeTypeOf('object');
      expect(tool.inputSchema, tool.name).not.toBeNull();
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });
});

describe('tools/call', () => {
  it('returns the tool payload as JSON in a text content block', async () => {
    const result = await handler('tools/call', {
      name: 'demo_echo',
      arguments: { value: 'hello' },
    });
    expect(result).toMatchObject({ content: [{ type: 'text' }] });
    expect(result).not.toHaveProperty('isError');
    expect(payload(result)).toEqual({ echoed: 'hello' });
  });

  it('treats missing or malformed arguments as an empty object', async () => {
    expect(payload(await handler('tools/call', { name: 'demo_echo' }))).toEqual({});
    expect(
      payload(await handler('tools/call', { name: 'demo_echo', arguments: 'nope' })),
    ).toEqual({});
  });

  it('reports an unknown tool as a protocol error, not an isError result', async () => {
    // The model cannot fix a nonexistent tool by retrying with new arguments.
    await expect(handler('tools/call', { name: 'no_such_tool' })).rejects.toThrow(JsonRpcError);
    await expect(handler('tools/call', { name: 'no_such_tool' })).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: 'Unknown tool: no_such_tool',
    });
  });

  it('rejects a call with a non-string name', async () => {
    await expect(handler('tools/call', { name: 42 })).rejects.toMatchObject({
      code: INVALID_PARAMS,
    });
  });

  it('surfaces a FleetError as an isError result carrying its message verbatim', async () => {
    const result = (await handler('tools/call', {
      name: 'demo_expected_failure',
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe('Unknown agent: ghost. Run `fleet list` to see active agents.');
  });

  it('contains an unexpected throw as an isError result rather than killing the session', async () => {
    const result = (await handler('tools/call', {
      name: 'demo_unexpected_failure',
    })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('worktree vanished mid-read');
  });
});

describe('method dispatch', () => {
  it('answers ping with an empty result', async () => {
    expect(await handler('ping', undefined)).toEqual({});
  });

  it('accepts lifecycle notifications without producing a payload', async () => {
    expect(await handler('notifications/initialized', undefined)).toBeNull();
    expect(await handler('notifications/cancelled', undefined)).toBeNull();
  });

  it('rejects an unknown method with method-not-found', async () => {
    await expect(handler('resources/list', undefined)).rejects.toMatchObject({
      code: METHOD_NOT_FOUND,
      message: 'Unknown method: resources/list',
    });
  });
});
