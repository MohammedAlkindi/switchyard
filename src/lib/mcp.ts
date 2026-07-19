import { FleetError } from './errors.js';
import { INVALID_PARAMS, JsonRpcError, METHOD_NOT_FOUND } from './jsonrpc.js';
import type { MethodHandler } from './jsonrpc.js';

/**
 * Model Context Protocol dispatch, independent of any transport. Pairing this
 * with `serveJsonRpc` produces the stdio server behind `fleet mcp`, but it is
 * a plain function of (method, params) so the protocol is testable without
 * spawning a subprocess.
 */

/**
 * The revision this server implements. Verified against the published spec on
 * 2026-07-19 rather than assumed: the wire format is newline-delimited JSON,
 * and a server that does not support the client's requested revision answers
 * with one it does support instead of erroring.
 *
 * A 2026-07-28 revision is in release-candidate state and makes MCP stateless
 * at the protocol layer. Clients speaking it fall back to the `initialize`
 * handshake against older servers, so this remains interoperable; revisit
 * after that revision is final rather than tracking a moving target.
 */
export const PROTOCOL_VERSION = '2025-11-25';

/**
 * Revisions whose tool semantics this server is compatible with. Everything
 * exposed here is a read-only tool returning text content, which has been
 * stable across all of these, so a client asking for any of them gets it back
 * verbatim rather than being forced to upgrade.
 */
export const COMPATIBLE_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** JSON Schema for a tool that takes no arguments, per the spec's recommendation. */
export const NO_ARGUMENTS = { type: 'object', additionalProperties: false } as const;

export interface McpTool {
  name: string;
  /** Human-readable display name, shown by clients that surface tool pickers. */
  title: string;
  description: string;
  /** JSON Schema for the arguments. MUST be an object schema, never null. */
  inputSchema: Record<string, unknown>;
  /** Produce the tool's payload. Throw `FleetError` for expected failures. */
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpServerOptions {
  serverInfo: { name: string; title?: string; version: string };
  tools: McpTool[];
  /** Optional guidance surfaced to the model at handshake time. */
  instructions?: string;
}

/** A `tools/call` result. Unstructured text content, per the spec's base shape. */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolCallResult {
  const result: ToolCallResult = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

/**
 * Negotiate the protocol revision. The spec is explicit that a version the
 * server does not support is *not* an error: it answers with one it does
 * support and lets the client decide whether to proceed.
 */
export function negotiateVersion(requested: unknown): string {
  if (typeof requested === 'string' && COMPATIBLE_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return PROTOCOL_VERSION;
}

/** Strip the handler off a tool so only its wire-visible fields are listed. */
function describeTool(tool: McpTool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/**
 * Build the MCP method handler. Tool payloads are JSON-stringified into a text
 * content block.
 *
 * The spec also offers `structuredContent`, which is rejected here: it must be
 * a JSON *object*, and `fleet_list` returns an array. Honoring it would mean
 * wrapping that one result in an envelope — a new result shape, which the v0.3
 * scope explicitly rules out — or having one tool answer differently from the
 * other three. Verbatim JSON text across all four is the consistent option.
 */
export function createMcpHandler(options: McpServerOptions): MethodHandler {
  const { serverInfo, tools, instructions } = options;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const initialize = (params: unknown) => {
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    return {
      protocolVersion: negotiateVersion(requested),
      // No `listChanged`: the tool set is fixed at build time, so the server
      // never emits notifications/tools/list_changed.
      capabilities: { tools: {} },
      serverInfo,
      ...(instructions === undefined ? {} : { instructions }),
    };
  };

  const callTool = async (params: unknown): Promise<ToolCallResult> => {
    const { name, arguments: args } = (params ?? {}) as {
      name?: unknown;
      arguments?: unknown;
    };

    if (typeof name !== 'string') {
      throw new JsonRpcError(INVALID_PARAMS, 'Invalid params: "name" must be a string');
    }

    const tool = byName.get(name);
    if (tool === undefined) {
      // Unknown tool is a protocol error: the model cannot fix it by retrying
      // with different arguments, so it does not belong in an isError result.
      throw new JsonRpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    }

    const argObject =
      typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};

    try {
      return textResult(JSON.stringify(await tool.run(argObject), null, 2));
    } catch (err) {
      // Every execution failure comes back as an isError result rather than a
      // JSON-RPC error. FleetError messages are written for humans to act on
      // and read equally well as model-facing correction. Unexpected failures
      // land here too, deliberately: a branch deleted or a worktree removed in
      // another terminal must not take down the calling agent's session.
      if (err instanceof FleetError) return textResult(err.message, true);
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`fleet ${name} failed: ${message}`, true);
    }
  };

  return async (method, params) => {
    switch (method) {
      case 'initialize':
        return initialize(params);

      // Lifecycle and keepalive notifications carry no reply; the transport
      // drops the return value for any message without an id.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: tools.map(describeTool) };

      case 'tools/call':
        return callTool(params);

      default:
        throw new JsonRpcError(METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  };
}
