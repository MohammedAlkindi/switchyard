import type { Readable, Writable } from 'node:stream';

/**
 * Newline-delimited JSON-RPC 2.0 over a byte stream — the framing MCP's stdio
 * transport specifies: one message per line, and no embedded newlines within a
 * message. `JSON.stringify` escapes newlines inside strings as `\n`, so a
 * single-line stringify satisfies that rule for any payload.
 */

/** Standard JSON-RPC 2.0 error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

/**
 * A failure the peer should receive as a JSON-RPC error object rather than as a
 * dropped connection. Anything else thrown by a handler becomes INTERNAL_ERROR
 * with its message — the loop never propagates.
 */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Handles one decoded request. Returning a value produces a `result`; throwing
 * `JsonRpcError` produces that `error`; throwing anything else produces
 * INTERNAL_ERROR.
 */
export type MethodHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown) {
  const error: JsonRpcErrorBody = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0' as const, id, error };
}

/** Narrow an unknown parsed value to a JSON-RPC id, or `null` if it isn't one. */
function readId(value: unknown): JsonRpcId {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

/**
 * Decode one line and dispatch it. Returns the response to write, or `null` for
 * a notification (a message with no `id`), which by spec gets no reply at all.
 *
 * Exported separately from the read loop so protocol behavior is testable
 * without a stream or a subprocess.
 */
export async function handleMessage(
  raw: string,
  handler: MethodHandler,
): Promise<JsonRpcResponse | null> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    // No id is recoverable from unparseable text, so the spec's null id applies.
    return errorResponse(null, PARSE_ERROR, 'Parse error: message is not valid JSON');
  }

  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return errorResponse(null, INVALID_REQUEST, 'Invalid Request: expected a JSON object');
  }

  const fields = message as Record<string, unknown>;
  // A notification is a request with no `id` member at all — distinct from
  // `id: null`, which is a (malformed but answerable) request.
  const isNotification = !('id' in fields);
  const id = readId(fields.id);

  if (typeof fields.method !== 'string') {
    if (isNotification) return null;
    return errorResponse(id, INVALID_REQUEST, 'Invalid Request: "method" must be a string');
  }

  try {
    const result = await handler(fields.method, fields.params);
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    // A notification gets no reply even when handling it failed; there is no
    // id to correlate a response to.
    if (isNotification) return null;
    if (err instanceof JsonRpcError) {
      return errorResponse(id, err.code, err.message, err.data);
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(id, INTERNAL_ERROR, message);
  }
}

/**
 * Read newline-delimited JSON-RPC from `input`, dispatch through `handler`, and
 * write responses to `output`. Resolves when `input` ends (stdin EOF), which is
 * how an MCP client signals shutdown.
 *
 * Requests are handled **strictly one at a time**. Switchyard's `withLock`
 * tracks reentrancy in a process-global counter, which is correct for a
 * short-lived CLI but would let a second concurrent call re-enter without
 * acquiring the lock in a long-lived server. v0.3 exposes no mutating tool so
 * this cannot trigger today; serializing now means the guarantee is already in
 * place when mutations arrive, rather than being retrofitted into a server
 * built assuming concurrency.
 */
export async function serveJsonRpc(
  input: Readable,
  output: Writable,
  handler: MethodHandler,
): Promise<void> {
  let buffer = '';
  // Tail of the serialized work chain; each line appends to it.
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (line: string): void => {
    queue = queue.then(async () => {
      const response = await handleMessage(line, handler);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    });
  };

  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffer += chunk as string;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      // Tolerate CRLF: clients on Windows may terminate lines with \r\n.
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== '') enqueue(line);
      newline = buffer.indexOf('\n');
    }
  }

  // A final line without a trailing newline is still a complete message.
  const tail = buffer.replace(/\r$/, '');
  if (tail.trim() !== '') enqueue(tail);

  await queue;
}
