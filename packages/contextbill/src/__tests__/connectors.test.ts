import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregate } from '../aggregate.js';
import { cacheWriteMultiplier } from '../cost.js';
import { parseTranscript } from '../parse.js';
import type { PriceTable } from '../types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;

/** One assistant turn that calls a tool, plus the user turn returning its result. */
function exchange(toolId: string, toolName: string, resultBody: string): string {
  return [
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', id: toolId, name: toolName, input: {} }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolId, content: resultBody }],
      },
    }),
  ].join('\n');
}

function statFrom(lines: string): ReturnType<typeof parseTranscript> {
  return parseTranscript(lines, {
    id: 's',
    project: 'p',
    isSubagent: false,
    bytes: lines.length,
  });
}

describe('per-server attribution', () => {
  it('counts calls and returned bytes against the server that owns the tool', () => {
    const stat = statFrom(
      [
        exchange('a', 'mcp__github__list_issues', 'x'.repeat(100)),
        exchange('b', 'mcp__github__get_commit', 'x'.repeat(50)),
        exchange('c', 'mcp__claude-in-chrome__navigate', 'x'.repeat(400)),
      ].join('\n'),
    );

    expect(stat.connectorCalls['github']).toBe(2);
    expect(stat.connectorCalls['claude-in-chrome']).toBe(1);
    expect(stat.connectorBytes['github']).toBe(150);
    expect(stat.connectorBytes['claude-in-chrome']).toBe(400);
  });

  it('leaves built-in tools out of the connector table entirely', () => {
    const stat = statFrom(exchange('a', 'Bash', 'x'.repeat(100)));
    expect(Object.keys(stat.connectorCalls)).toEqual([]);
    expect(Object.keys(stat.connectorBytes)).toEqual([]);
  });

  it('tracks a browser server as a connector as well as a browser category', () => {
    // A browser tool is an MCP tool. It has to appear in both cuts, or the
    // connector table silently omits what is usually the largest server.
    const stat = statFrom(exchange('a', 'mcp__claude-in-chrome__navigate', 'x'.repeat(90)));
    expect(stat.connectorBytes['claude-in-chrome']).toBe(90);
    expect(stat.toolBytes.browser).toBe(90);
    expect(stat.toolBytes.connectors).toBeUndefined();
  });

  it('records a call whose result never came back', () => {
    // A tool_use with no matching tool_result is a call that was made — an
    // interrupted or errored one. Counting it only on the result would hide
    // exactly the calls worth looking at.
    const stat = statFrom(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 'a', name: 'mcp__github__list_issues', input: {} }],
        },
      }),
    );
    expect(stat.connectorCalls['github']).toBe(1);
    expect(stat.connectorBytes['github']).toBeUndefined();
  });
});

describe('byConnector', () => {
  const stats = [
    statFrom(
      [
        exchange('a', 'mcp__github__list_issues', 'x'.repeat(300)),
        exchange('b', 'mcp__claude-in-chrome__navigate', 'x'.repeat(700)),
      ].join('\n'),
    ),
  ];
  const report = aggregate(stats, {
    table,
    ttl: '5m',
    cacheWriteMult: cacheWriteMultiplier(table, '5m'),
  });

  it('ranks servers by cost', () => {
    expect(report.byConnector.map((c) => c.server)).toEqual(['claude-in-chrome', 'github']);
  });

  it('splits the content pool in proportion to bytes returned', () => {
    const chrome = report.byConnector.find((c) => c.server === 'claude-in-chrome');
    const github = report.byConnector.find((c) => c.server === 'github');
    // 700 bytes against 300, and these are the only two tools in the corpus.
    expect((chrome?.usd ?? 0) / (github?.usd ?? 1)).toBeCloseTo(700 / 300, 6);
  });

  it('never claims more than the connector spend it can actually see', () => {
    // The table is built from calls that happened. It must not exceed the
    // content pool, which is what would happen if the startup prefix ever
    // leaked into it — the prefix is where an uncalled connector's cost lives,
    // and this table cannot attribute that to anyone.
    const summed = report.byConnector.reduce((n, c) => n + c.usd, 0);
    const contentAndOutput = report.cost.total - report.findings.startupPrefixUsd;
    expect(summed).toBeLessThan(contentAndOutput + 1e-9);
  });

  it('is empty for a corpus that called no connector at all', () => {
    const plain = aggregate([statFrom(exchange('a', 'Bash', 'x'.repeat(10)))], {
      table,
      ttl: '5m',
      cacheWriteMult: cacheWriteMultiplier(table, '5m'),
    });
    expect(plain.byConnector).toEqual([]);
  });
});
