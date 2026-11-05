import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  INTERNAL_ERROR,
  INVALID_REQUEST,
  JsonRpcError,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  handleMessage,
  serveJsonRpc,
} from '../src/lib/jsonrpc.js';
import type { MethodHandler } from '../src/lib/jsonrpc.js';

/** Echo the method name back, so responses are easy to correlate in tests. */
const echo: MethodHandler = (method, params) => ({ method, params });

/**
 * Drive `serveJsonRpc` over in-memory streams and collect the parsed responses.
 * `input` is written verbatim so tests control the exact framing on the wire.
 */
async function serve(input: string, handler: MethodHandler = echo): Promise<unknown[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

  const done = serveJsonRpc(stdin, stdout, handler);
  stdin.end(input);
  await done;

  return chunks
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

describe('handleMessage', () => {
  it('answers a request with a jsonrpc result carrying the same id', async () => {
    const response = await handleMessage('{"jsonrpc":"2.0","id":7,"method":"ping"}', echo);
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { method: 'ping', params: undefined },
    });
  });

  it('returns no response at all for a notification', async () => {
    expect(await handleMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}', echo))
      .toBeNull();
  });

  it('swallows a handler failure on a notification rather than inventing an id', async () => {
    const boom: MethodHandler = () => {
      throw new Error('handler exploded');
    };
    expect(await handleMessage('{"jsonrpc":"2.0","method":"whatever"}', boom)).toBeNull();
  });

  it('reports unparseable text as a parse error with a null id', async () => {
    const response = await handleMessage('{not json at all', echo);
    expect(response).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR } });
  });

  it('rejects a non-object message as an invalid request', async () => {
    expect(await handleMessage('[1,2,3]', echo)).toMatchObject({
      id: null,
      error: { code: INVALID_REQUEST },
    });
    expect(await handleMessage('"a string"', echo)).toMatchObject({
      error: { code: INVALID_REQUEST },
    });
  });

  it('rejects a request whose method is missing or not a string', async () => {
    const response = await handleMessage('{"jsonrpc":"2.0","id":3,"method":42}', echo);
    expect(response).toMatchObject({ id: 3, error: { code: INVALID_REQUEST } });
  });

  it('passes a JsonRpcError through with its code and data intact', async () => {
    const handler: MethodHandler = () => {
      throw new JsonRpcError(METHOD_NOT_FOUND, 'Unknown method: nope', { method: 'nope' });
    };
    const response = await handleMessage('{"jsonrpc":"2.0","id":"x","method":"nope"}', handler);
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      error: {
        code: METHOD_NOT_FOUND,
        message: 'Unknown method: nope',
        data: { method: 'nope' },
      },
    });
  });

  it('maps an unexpected throw to an internal error instead of propagating', async () => {
    const handler: MethodHandler = () => {
      throw new TypeError('cannot read property of undefined');
    };
    const response = await handleMessage('{"jsonrpc":"2.0","id":1,"method":"boom"}', handler);
    expect(response).toMatchObject({
      id: 1,
      error: { code: INTERNAL_ERROR, message: 'cannot read property of undefined' },
    });
  });
});

describe('serveJsonRpc framing', () => {
  it('handles several newline-delimited messages arriving in one chunk', async () => {
    const responses = await serve(
      '{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n',
    );
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ id: 1 });
    expect(responses[1]).toMatchObject({ id: 2 });
  });

  it('reassembles a message split across chunk boundaries', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

    const done = serveJsonRpc(stdin, stdout, echo);
    stdin.write('{"jsonrpc":"2.0","id":9,');
    stdin.write('"method":"split"}');
    stdin.end('\n');
    await done;

    expect(JSON.parse(chunks.join('').trim())).toMatchObject({
      id: 9,
      result: { method: 'split' },
    });
  });

  it('accepts CRLF line endings', async () => {
    const responses = await serve('{"jsonrpc":"2.0","id":1,"method":"a"}\r\n');
    expect(responses).toEqual([
      { jsonrpc: '2.0', id: 1, result: { method: 'a', params: undefined } },
    ]);
  });

  it('handles a final message with no trailing newline', async () => {
    const responses = await serve('{"jsonrpc":"2.0","id":4,"method":"tail"}');
    expect(responses).toMatchObject([{ id: 4 }]);
  });

  it('ignores blank lines', async () => {
    const responses = await serve('\n\n{"jsonrpc":"2.0","id":1,"method":"a"}\n\n');
    expect(responses).toHaveLength(1);
  });

  it('never writes a response line containing an embedded newline', async () => {
    // The stdio transport forbids embedded newlines; a multi-line string in a
    // result must survive as an escaped \n inside one physical line.
    const handler: MethodHandler = () => ({ text: 'first\nsecond\nthird' });
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    const done = serveJsonRpc(stdin, stdout, handler);
    stdin.end('{"jsonrpc":"2.0","id":1,"method":"multiline"}\n');
    await done;

    const written = chunks.join('');
    expect(written.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(JSON.parse(written)).toMatchObject({ result: { text: 'first\nsecond\nthird' } });
  });

  it('keeps serving after a malformed line', async () => {
    const responses = await serve('garbage\n{"jsonrpc":"2.0","id":2,"method":"after"}\n');
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ error: { code: PARSE_ERROR } });
    expect(responses[1]).toMatchObject({ id: 2 });
  });

  it('writes nothing for a stream of only notifications', async () => {
    const responses = await serve(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' +
        '{"jsonrpc":"2.0","method":"notifications/cancelled"}\n',
    );
    expect(responses).toEqual([]);
  });

  it('handles requests strictly one at a time', async () => {
    // Interleaving would show up as B starting before A finished.
    const events: string[] = [];
    const handler: MethodHandler = async (method) => {
      events.push(`start:${method}`);
      await new Promise((resolve) => setTimeout(resolve, method === 'slow' ? 25 : 0));
      events.push(`end:${method}`);
      return null;
    };

    await serve(
      '{"jsonrpc":"2.0","id":1,"method":"slow"}\n{"jsonrpc":"2.0","id":2,"method":"fast"}\n',
      handler,
    );

    expect(events).toEqual(['start:slow', 'end:slow', 'start:fast', 'end:fast']);
  });

  it('resolves when stdin ends, which is how a client signals shutdown', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const done = serveJsonRpc(stdin, stdout, echo);
    stdin.end();
    await expect(done).resolves.toBeUndefined();
  });
});
