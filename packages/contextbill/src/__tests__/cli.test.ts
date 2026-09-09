import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { parseArgs } from '../cli.js';

const HOME = 'C:\\Users\\jdoe';

describe('parseArgs', () => {
  it('defaults to the Claude Code transcript root and the conservative cache rate', () => {
    const o = parseArgs([], HOME);
    expect(o.root.endsWith('projects')).toBe(true);
    expect(o.ttl).toBe('5m');
    expect(o.showPaths).toBe(false);
    expect(o.json).toBe(false);
    expect(o.unknown).toEqual([]);
  });

  it('accepts both --flag value and --flag=value forms', () => {
    expect(parseArgs(['--cache-ttl', '1h'], HOME).ttl).toBe('1h');
    expect(parseArgs(['--cache-ttl=1h'], HOME).ttl).toBe('1h');
    expect(parseArgs(['--top=5'], HOME).top).toBe(5);
  });

  it('ignores an invalid cache-ttl rather than charging a made-up rate', () => {
    expect(parseArgs(['--cache-ttl=1hr'], HOME).ttl).toBe('5m');
    expect(parseArgs(['--cache-ttl=banana'], HOME).ttl).toBe('5m');
  });

  it('ignores a nonsensical --top', () => {
    expect(parseArgs(['--top=0'], HOME).top).toBe(20);
    expect(parseArgs(['--top=-4'], HOME).top).toBe(20);
    expect(parseArgs(['--top=abc'], HOME).top).toBe(20);
  });

  it('collects unrecognised flags so a typo is not silently ignored', () => {
    // The failure this prevents: `--show-path` (singular) quietly doing nothing
    // and the user believing their paths were shown.
    const o = parseArgs(['--show-path', '--bogus'], HOME);
    expect(o.unknown).toEqual(['--show-path', '--bogus']);
    expect(o.showPaths).toBe(false);
  });

  it('does not treat a bare value as an unknown flag', () => {
    expect(parseArgs(['--root', '/tmp/x'], HOME).unknown).toEqual([]);
  });

  it('recognises the real flags', () => {
    const o = parseArgs(['--json', '--show-paths'], HOME);
    expect(o.json).toBe(true);
    expect(o.showPaths).toBe(true);
    expect(o.unknown).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * The terminal report
 *
 * Everything below spawns the built CLI. `--json` and the HTML report each have
 * their own tests; this file covers the block printed to stdout, which is the
 * surface most people actually read and the one where a correction that changed
 * the headline total went undisclosed.
 *
 * Like `entrypoint.test.ts` this reads dist/; the pretest script builds it.
 * -------------------------------------------------------------------------- */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const projectFixtures = path.join(repoRoot, 'fixtures', 'projects');
const crossFileFixtures = path.join(repoRoot, 'fixtures', 'crossfile');
const codexFixtures = path.join(repoRoot, 'fixtures', 'codex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextbill-cli-'));
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run the built CLI. Never throws; stdout and the exit code are the point. */
function run(args: readonly string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    input: '',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** A report written somewhere disposable, so a test never touches the checkout. */
function reportPath(name: string): string {
  return path.join(tmp, `${name}.html`);
}

/**
 * One assistant line in the transcript format `parse.ts` reads.
 *
 * Hand-built here rather than added to `fixtures/`: these corpora exist to pin
 * the shape of two terminal sentences, and `fixtures/projects` is the pricing
 * anchor's corpus, which must stay id-free (see CLAUDE.md).
 */
function assistantLine(opts: {
  uuid: string;
  messageId: string;
  timestamp: string;
  sessionId: string;
}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    uuid: opts.uuid,
    timestamp: opts.timestamp,
    sessionId: opts.sessionId,
    type: 'assistant',
    message: {
      id: opts.messageId,
      model: 'claude-opus-5',
      role: 'assistant',
      content: [],
      usage: {
        input_tokens: 1_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10_000,
        output_tokens: 500,
      },
    },
  });
}

/**
 * A corpus whose span brackets one WHOLE calendar month, so `--plan` reports a
 * break-even multiple instead of declining to.
 *
 * `withCollision` adds a second February transcript carrying the same
 * `message.id` as the first under a different `uuid` — the shape the cross-file
 * merge refuses, because nothing proves the two records are one request. That
 * leaves a residual double-count sitting inside the value the multiple divides.
 */
function planCorpus(name: string, withCollision: boolean): string {
  const root = path.join(tmp, name, 'projects');
  const project = path.join(root, 'plan-demo');
  fs.mkdirSync(project, { recursive: true });

  const write = (file: string, lines: readonly string[]): void => {
    fs.writeFileSync(path.join(project, file), `${lines.join('\n')}\n`, 'utf8');
  };

  // January and March bracket February: a month is complete only when the
  // corpus starts before it and ends after it.
  write('jan.jsonl', [
    assistantLine({
      uuid: 'u-jan',
      messageId: 'msg-jan',
      timestamp: '2026-01-20T00:00:00.000Z',
      sessionId: 'jan',
    }),
  ]);
  write('feb-a.jsonl', [
    assistantLine({
      uuid: 'u-feb-a',
      messageId: 'msg-feb',
      timestamp: '2026-02-10T00:00:00.000Z',
      sessionId: 'feb-a',
    }),
  ]);
  if (withCollision) {
    write('feb-b.jsonl', [
      assistantLine({
        uuid: 'u-feb-b',
        messageId: 'msg-feb',
        timestamp: '2026-02-11T00:00:00.000Z',
        sessionId: 'feb-b',
      }),
    ]);
  }
  write('mar.jsonl', [
    assistantLine({
      uuid: 'u-mar',
      messageId: 'msg-mar',
      timestamp: '2026-03-10T00:00:00.000Z',
      sessionId: 'mar',
    }),
  ]);
  return root;
}

describe('the cross-file merge is disclosed on the terminal', () => {
  /**
   * The merge changes the HEADLINE TOTAL. On the corpus this was measured
   * against it removed $1,145.70, 7.40% of the run, so a user comparing today's
   * output with last week's sees a large drop with nothing on screen to explain
   * it. The HTML report has always stated the merge; the terminal did not, and
   * cli.ts's own comment two lines above the residual line already required
   * exactly this ("a reader comparing this run against an older one needs to
   * know the difference is a fixed double-count").
   */
  it('names the merge and what it removed, so the drop has a stated cause', () => {
    const r = run(['--root', crossFileFixtures, '--out', reportPath('merge')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('merged');
    // The dollars, not just a count: a count of messages is not a share of a
    // bill, and the drop a reader is trying to explain is denominated in money.
    expect(r.out).toMatch(/\$\d[\d,.]*\s+that would otherwise be counted twice/);
  });

  it('says nothing about a merge on a corpus where none happened', () => {
    // fixtures/projects carries no message.id at all, so nothing can be merged.
    // A line printed unconditionally would be boilerplate rather than a finding.
    const r = run(['--root', projectFixtures, '--out', reportPath('no-merge')]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('that would otherwise be counted twice');
  });
});

describe('the unmerged residual is not labelled a resumed session', () => {
  /**
   * This label is now exactly backwards, and it inverted the moment the
   * cross-file merge landed. A PROVABLE resume — same message id, same line
   * uuid — is precisely the case that gets merged. What survives to the
   * residual is the set where the ids matched and no uuid did, which is either
   * a rewrite scattered across sibling subagent files or an API gateway handing
   * one id to two independent sessions. Neither is a resumed session, and
   * report.ts was corrected for this while cli.ts was not.
   *
   * The string is asserted, not just the count, so the label cannot silently
   * invert again the next time this correction is revisited.
   */
  it('states why the copies were left counted instead of calling them resumes', () => {
    const r = run(['--root', crossFileFixtures, '--out', reportPath('residual')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('NOT merged');
    expect(r.out).not.toContain('(resumed sessions)');
    // What is actually true of them: nothing proved they were the same request.
    expect(r.out).toContain('nothing proves they are the same request');
  });
});

describe('--plan does not print a bare multiple over a value it knows is inflated', () => {
  /**
   * The break-even multiple divides API-equivalent value by fees, so anything
   * still double-counted in the value pushes it UP — the single direction this
   * feature promises it never errs in, which is why `planUtilization` charges
   * every idle month in the span and refuses a multiple over a partial one.
   *
   * The residual double-count above sits inside `cost.total`, therefore inside
   * `byMonth[].usd`, therefore inside the numerator. It is measured, so it can
   * be stated rather than hedged about.
   */
  it('flags the multiple as a ceiling when a residual double-count remains', () => {
    const root = planCorpus('plan-collision', true);
    const r = run(['--root', root, '--plan', 'max20', '--out', reportPath('plan-collision')]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/x break-even/);
    expect(r.out).toContain('counted twice');
    expect(r.out).toContain('ceiling');
  });

  it('adds no caveat when nothing is double-counted', () => {
    // A stale caveat is worse than none: it teaches a reader to discount a
    // number that needs no discount.
    const root = planCorpus('plan-clean', false);
    const r = run(['--root', root, '--plan', 'max20', '--out', reportPath('plan-clean')]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/x break-even/);
    expect(r.out).not.toContain('ceiling');
  });
});

describe('the basis line names the vendor whose rates were actually applied', () => {
  /**
   * prices.json carried Anthropic rates only until 2026-09-07, so "Anthropic
   * API rates" was true of every dollar this tool had ever printed. It now
   * carries gpt-5.6-sol and gpt-5.6-terra, and a `--source codex` run prices
   * real OpenAI usage and then attributes it to Anthropic — a sourcing claim
   * about someone else's numbers, which is the kind of wrong this file's own
   * header rules out.
   */
  it('names Anthropic alone on a plain Claude Code run', () => {
    const r = run(['--root', projectFixtures, '--out', reportPath('basis-claude')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Anthropic');
    expect(r.out).not.toContain('OpenAI API rates');
  });

  it('names OpenAI, not Anthropic, when only Codex usage was priced', () => {
    const r = run([
      '--source',
      'codex',
      '--codex-root',
      codexFixtures,
      '--out',
      reportPath('basis-codex'),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/published OpenAI API rates/);
    expect(r.out).not.toMatch(/published Anthropic API rates/);
  });

  it('names both when both were priced', () => {
    const r = run([
      '--source',
      'all',
      '--root',
      projectFixtures,
      '--codex-root',
      codexFixtures,
      '--out',
      reportPath('basis-all'),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/published Anthropic and OpenAI API rates/);
  });
});

describe('--help describes the price table that ships, not the one that used to', () => {
  it('no longer claims Codex dollars are left blank', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    // Both halves of the old claim. The first is now false of prices.json and
    // the second is false of the output: `--source codex` prints dollars.
    expect(r.out).not.toMatch(/no OpenAI ones/);
    expect(r.out).not.toMatch(/left blank/);
    expect(r.out).toMatch(/Anthropic and OpenAI rates/);
  });

  it('still says a model with no rate is counted rather than guessed at', () => {
    // gpt-5.5 is deliberately unpriced, so the honest half of the old text is
    // still load-bearing and must survive the correction.
    const r = run(['--help']);
    expect(r.out).toMatch(/never guessed/);
  });
});
