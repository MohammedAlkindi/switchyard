import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregate } from '@core/aggregate';
import { cacheWriteMultiplier } from '@core/cost';
import { scanAll } from '@core/scan';
import type { PriceTable } from '@core/types';
import priceTable from '@prices';

import { describePath, scanFiles } from '../browser-scan';

const TABLE = priceTable as unknown as PriceTable;
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/projects',
);

/**
 * A stand-in for a picked `File`.
 *
 * `webkitRelativePath` is read-only on a real File and cannot be set, and the
 * whole point of these tests is a `.text()` that misbehaves, so the browser's
 * own File is not usable here. Everything `scanFiles` touches is present.
 */
function pickedFile(
  relPath: string,
  text: string,
  behaviour: { failures?: number; error?: Error } = {},
): File {
  let calls = 0;
  const failures = behaviour.failures ?? 0;
  const bytes = Buffer.byteLength(text, 'utf8');

  return {
    name: relPath.split('/').pop() ?? 'session.jsonl',
    webkitRelativePath: relPath,
    size: bytes,
    text: async () => {
      calls += 1;
      if (calls <= failures) throw behaviour.error ?? new Error('boom');
      return text;
    },
  } as unknown as File;
}

/** A DOMException-shaped failure, which is what a stale handle actually throws. */
function notReadable(): Error {
  const err = new Error('');
  err.name = 'NotReadableError';
  return err;
}

const ONE_TURN = JSON.stringify({
  type: 'assistant',
  message: {
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});

describe('describePath', () => {
  it('reads project and id from a directory pick', () => {
    expect(describePath('projects/C--Users-x-repo/abc.jsonl')).toEqual({
      project: 'C--Users-x-repo',
      id: 'abc',
      isSubagent: false,
    });
  });

  it('flags a nested transcript as a subagent', () => {
    expect(describePath('projects/C--Users-x-repo/sub/abc.jsonl').isSubagent).toBe(true);
  });

  it('falls back to unknown when the browser gives no relative path', () => {
    expect(describePath('abc.jsonl').project).toBe('unknown');
  });
});

describe('scanFiles resilience', () => {
  it('skips one unreadable file instead of failing the whole run', async () => {
    const files = [
      pickedFile('projects/p/a.jsonl', ONE_TURN),
      pickedFile('projects/p/b.jsonl', ONE_TURN, { failures: 99, error: notReadable() }),
      pickedFile('projects/p/c.jsonl', ONE_TURN),
    ];

    const result = await scanFiles(files, '');

    expect(result.stats).toHaveLength(2);
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0]?.path).toBe('projects/p/b.jsonl');
  });

  it('names a stale handle in words rather than showing an empty message', async () => {
    const files = [pickedFile('projects/p/a.jsonl', ONE_TURN, { failures: 99, error: notReadable() })];

    const result = await scanFiles(files, '');

    expect(result.unreadable[0]?.reason).toBe('changed on disk while it was being read');
  });

  it('retries once, so a file that settles is counted rather than dropped', async () => {
    const files = [pickedFile('projects/p/a.jsonl', ONE_TURN, { failures: 1, error: notReadable() })];

    const result = await scanFiles(files, '');

    expect(result.stats).toHaveLength(1);
    expect(result.unreadable).toHaveLength(0);
    expect(result.stats[0]?.turns).toBe(1);
  });

  it('reports coverage that adds up, so a partial total is visibly partial', async () => {
    const files = [
      pickedFile('projects/p/a.jsonl', ONE_TURN),
      pickedFile('projects/p/b.jsonl', ONE_TURN, { failures: 99 }),
      pickedFile('projects/p/c.jsonl', ONE_TURN, { failures: 99 }),
    ];

    const result = await scanFiles(files, '');

    expect(result.filesSeen).toBe(3);
    expect(result.stats.length + result.unreadable.length).toBe(result.filesSeen);
  });

  it('returns no stats rather than throwing when every file is unreadable', async () => {
    const files = [
      pickedFile('projects/p/a.jsonl', ONE_TURN, { failures: 99 }),
      pickedFile('projects/p/b.jsonl', ONE_TURN, { failures: 99 }),
    ];

    const result = await scanFiles(files, '');

    expect(result.stats).toHaveLength(0);
    expect(result.unreadable).toHaveLength(2);
  });

  it('counts a readable but usage-free transcript as empty, not as unreadable', async () => {
    const files = [pickedFile('projects/p/a.jsonl', '')];

    const result = await scanFiles(files, '');

    expect(result.emptyFiles).toBe(1);
    expect(result.unreadable).toHaveLength(0);
  });
});

/**
 * The invariant the two-surface design rests on.
 *
 * `scan.ts` and `browser-scan.ts` are separate readers by necessity — one needs
 * `node:fs`, the other cannot have it — and they feed the same `parseTranscript`.
 * Nothing enforced that they agree until this test. Each reader is
 * self-consistent, so a divergence would show up as the CLI and the dashboard
 * quietly reporting different numbers for the same directory, with every other
 * test still green.
 */
describe('the two readers agree', () => {
  it('produces identical aggregates from the same corpus', async () => {
    const cliStats = scanAll(FIXTURES);

    const picked: File[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const next = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, next);
        else if (entry.name.endsWith('.jsonl')) {
          // The picker prefixes the chosen folder's own name; scanAll's paths
          // are relative to the root, so add it back to match the depths.
          picked.push(pickedFile(`projects/${next}`, fs.readFileSync(full, 'utf8')));
        }
      }
    };
    walk(FIXTURES, '');

    const { stats: webStats } = await scanFiles(picked, '');

    const opts = {
      table: TABLE,
      ttl: '5m' as const,
      cacheWriteMult: cacheWriteMultiplier(TABLE, '5m'),
      topN: 25,
    };
    const fromCli = aggregate(cliStats, opts);
    const fromWeb = aggregate(webStats, opts);

    expect(webStats).toHaveLength(cliStats.length);
    expect(fromWeb.turns).toBe(fromCli.turns);
    expect(fromWeb.sessionCount).toBe(fromCli.sessionCount);
    expect(fromWeb.transcriptCount).toBe(fromCli.transcriptCount);
    expect(fromWeb.cost).toEqual(fromCli.cost);
    expect(fromWeb.usage).toEqual(fromCli.usage);
    expect(fromWeb.byModel).toEqual(fromCli.byModel);
    expect(fromWeb.byCategory).toEqual(fromCli.byCategory);
    expect(fromWeb.findings.medianStartupPrefix).toBe(fromCli.findings.medianStartupPrefix);
    expect(fromWeb.findings.startupPrefixUsd).toBe(fromCli.findings.startupPrefixUsd);
  });
});
