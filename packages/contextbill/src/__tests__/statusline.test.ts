import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { compactTokens, formatStatusline, parseArgs, transcriptPathFromStdin } from '../cli.js';

/**
 * `--statusline` runs inside someone's prompt, which gives it two properties
 * nothing else in this CLI has: its stdout is pasted into a UI, and its failure
 * mode is a stack trace in that same UI. The end-to-end cases below spawn the
 * built CLI rather than calling `runStatusline`, because the exit code and the
 * emptiness of stderr ARE the behaviour under test and neither is observable
 * from inside the process.
 *
 * Like `entrypoint.test.ts` this reads dist/; the pretest script builds it.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'dist', 'cli.js');
const fixtures = path.join(root, 'fixtures', 'projects');
const oneTranscript = path.join(fixtures, 'demo-project', 'session-a.jsonl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextbill-statusline-'));
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run the built CLI with `stdin` piped in. Never throws; the code is the point. */
function run(args: readonly string[], stdin = ''): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      input: stdin,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

describe('statusline flags', () => {
  it('is off by default and takes session scope when on', () => {
    expect(parseArgs([], 'C:\\Users\\jdoe').statusline).toBe(false);
    const o = parseArgs(['--statusline'], 'C:\\Users\\jdoe');
    expect(o.statusline).toBe(true);
    expect(o.scope).toBe('session');
  });

  it('reports an unrecognised scope instead of quietly measuring the other one', () => {
    // The failure this prevents: `--scope toady` silently measuring one session
    // and reading as a quiet day.
    expect(parseArgs(['--scope', 'today'], 'C:\\U').scope).toBe('today');
    expect(parseArgs(['--scope=toady'], 'C:\\U').unknown).toEqual(['--scope toady']);
    expect(parseArgs(['--scope=toady'], 'C:\\U').scope).toBe('session');
  });
});

describe('compactTokens', () => {
  it('keeps a digit of precision under ten units and drops it above', () => {
    expect(compactTokens(0)).toBe('0');
    expect(compactTokens(999)).toBe('999');
    expect(compactTokens(1_500)).toBe('1.5K');
    expect(compactTokens(412_000)).toBe('412K');
    expect(compactTokens(7_500_000)).toBe('7.5M');
    expect(compactTokens(484_000_000)).toBe('484M');
  });

  it('reaches billions, because --scope today does', () => {
    // Measured 3,960M on an ordinary day's corpus. "3960M" is wider and harder
    // to read than "4.0B", and a prompt line is where width costs most.
    expect(compactTokens(3_960_000_000)).toBe('4.0B');
    expect(compactTokens(12_000_000_000)).toBe('12B');
  });
});

describe('formatStatusline', () => {
  it('never drops the API-equivalent framing', () => {
    // A bare dollar figure in a prompt reads as a bill. That misreading is the
    // one this whole tool exists to prevent, so the two words stay even though
    // they are the widest thing on the line.
    const line = formatStatusline({
      usd: 1.23,
      turns: 87,
      tokens: 412_000,
      scope: 'session',
      unpricedModels: 0,
    });
    expect(line).toBe('$1.23 API-equiv · 87 turns · 412K tok · session');
  });

  it('labels the today scope by what it actually measures', () => {
    // The filter is file mtime, so a session that began yesterday is counted in
    // full. "active today" is honest about that; "today" would not be.
    const line = formatStatusline({
      usd: 0,
      turns: 0,
      tokens: 0,
      scope: 'today',
      unpricedModels: 0,
    });
    expect(line).toContain('active today');
    expect(line).not.toContain('· today');
  });

  it('says when the token count covers more than the dollar figure does', () => {
    const line = formatStatusline({
      usd: 4,
      turns: 10,
      tokens: 5_000,
      scope: 'session',
      unpricedModels: 2,
    });
    expect(line).toContain('2 unpriced');
  });

  it('stays on one line', () => {
    for (const scope of ['session', 'today'] as const) {
      const line = formatStatusline({
        usd: 1234.5,
        turns: 10_000,
        tokens: 3_960_000_000,
        scope,
        unpricedModels: 3,
      });
      expect(line).not.toContain('\n');
    }
  });
});

describe('transcriptPathFromStdin', () => {
  it('reads the path Claude Code supplies', () => {
    expect(transcriptPathFromStdin('{"transcript_path":"/tmp/a.jsonl"}')).toBe('/tmp/a.jsonl');
  });

  it('treats anything unexpected as absent rather than throwing', () => {
    // This payload is not ours and its shape can change under us. A statusline
    // that threw on a new field would break on the next Claude Code release.
    expect(transcriptPathFromStdin('')).toBeNull();
    expect(transcriptPathFromStdin('not json')).toBeNull();
    expect(transcriptPathFromStdin('{}')).toBeNull();
    expect(transcriptPathFromStdin('{"transcript_path":null}')).toBeNull();
    expect(transcriptPathFromStdin('{"transcript_path":42}')).toBeNull();
    expect(transcriptPathFromStdin('{"transcript_path":"  "}')).toBeNull();
    expect(transcriptPathFromStdin('[1,2,3]')).toBeNull();
  });
});

describe('statusline end to end', () => {
  it('prints exactly one line and writes no report file', () => {
    const before = fs.readdirSync(tmp);
    const r = run(['--statusline', '--root', fixtures, '--out', path.join(tmp, 'report.html')]);
    expect(r.code).toBe(0);
    expect(r.out.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(r.out).toContain('API-equiv');
    expect(fs.readdirSync(tmp)).toEqual(before);
  });

  it('prices the transcript named on stdin', () => {
    const r = run(['--statusline', '--root', fixtures], JSON.stringify({
      session_id: 'fixture',
      transcript_path: oneTranscript,
    }));
    expect(r.code).toBe(0);
    // session-a is a three-turn hand-built fixture; the newest-file fallback
    // would have picked some other file under the same root.
    expect(r.out.trim()).toContain('3 turns');
    expect(r.out.trim()).toContain('session');
  });

  it('falls back to the newest transcript when stdin carries no usable path', () => {
    const r = run(['--statusline', '--root', fixtures], '{"session_id":"x"}');
    expect(r.code).toBe(0);
    expect(r.out).toContain('API-equiv');
  });

  it('exits non-zero and SILENTLY when there is nothing to measure', () => {
    // The whole point of the mode: this output goes into a prompt, so a
    // missing root has to produce no line rather than an explanation.
    const r = run(['--statusline', '--root', path.join(tmp, 'does-not-exist')]);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toBe('');
  });

  it('says nothing about an unrecognised flag either', () => {
    // Every other mode prints a warning for a typo'd flag. Here that warning
    // would be the only thing in the prompt, which is worse than the typo.
    const r = run(['--statusline', '--root', fixtures, '--show-path']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });

  it('measures the active-today scope without writing a file', () => {
    const r = run(['--statusline', '--scope', 'today', '--root', fixtures]);
    // The fixture files' mtimes are whatever the checkout produced, so this
    // asserts the shape of the answer rather than its value: either a line
    // labelled "active today", or a silent non-zero when none qualify.
    if (r.code === 0) expect(r.out).toContain('active today');
    else expect(r.out).toBe('');
    expect(r.err).toBe('');
  });
});
