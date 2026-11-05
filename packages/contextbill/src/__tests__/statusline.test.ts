import { spawn, spawnSync } from 'node:child_process';
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

/**
 * Run the built CLI with `stdin` piped in. Never throws; the code is the point.
 *
 * `spawnSync` rather than `execFileSync` because stderr is part of what is
 * under test here. `execFileSync` only surfaces stderr by throwing, so on a
 * zero exit it returned `err: ''` unconditionally and every `expect(r.err)
 * .toBe('')` in this file passed without looking at anything.
 */
function run(args: readonly string[], stdin = ''): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    input: stdin,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
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
      unreadable: 0,
      limit: null,
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
      unreadable: 0,
      limit: null,
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
      unreadable: 0,
      limit: null,
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
        unreadable: 0,
        limit: null,
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

describe('an unreadable transcript is not a transcript with nothing in it', () => {
  /**
   * The contract at the top of `runStatusline` is that it prints nothing and
   * exits non-zero when it cannot answer. Before this, `statTranscript` called
   * `scanFile` without the `onUnreadable` callback, so a read error came back
   * as an EMPTY stat and the mode printed a confident "$0.00 API-equiv · 0
   * turns" for a file it never opened — the one shape of wrong answer this
   * codebase is arranged to prevent, in the one place a wrong answer is pasted
   * into someone's prompt.
   *
   * `scan.ts` already hands the reason out; `scanCorpus` has used it since it
   * was added. This path threw it away.
   */
  const unreadable = path.join(tmp, 'not-a-file');
  fs.mkdirSync(unreadable, { recursive: true });

  it('prints nothing and exits non-zero when the named transcript cannot be read', () => {
    const empty = path.join(tmp, 'empty-root');
    fs.mkdirSync(empty, { recursive: true });
    const r = run(
      ['--statusline', '--root', empty],
      JSON.stringify({ session_id: 'x', transcript_path: unreadable }),
    );
    expect(r.out).toBe('');
    expect(r.err).toBe('');
    expect(r.code).not.toBe(0);
  });

  it('does not silently fall back to another session when the named one is unreadable', () => {
    // The fallback exists for running the command by hand. Reaching for it
    // after a supplied path failed would report a DIFFERENT session's numbers
    // under this session's prompt, which is worse than reporting none.
    const r = run(
      ['--statusline', '--root', fixtures],
      JSON.stringify({ session_id: 'x', transcript_path: unreadable }),
    );
    expect(r.out).toBe('');
    expect(r.code).not.toBe(0);
  });

  it('states the files it could not read rather than folding them in as zero', () => {
    const line = formatStatusline({
      usd: 4,
      turns: 10,
      tokens: 5_000,
      scope: 'today',
      unpricedModels: 0,
      unreadable: 2,
      limit: null,
    });
    expect(line).toContain('2 unread');
  });
});

describe('rate-limit window on the statusline', () => {
  /**
   * The only figure this tool prints that a transcript cannot produce. It rides
   * in on the same stdin payload the transcript path does, so it costs nothing
   * to read and it is the vendor's own count rather than a reconstruction.
   */
  const oneHour = 3_600_000;

  /** A payload naming the fixture transcript plus a live five-hour window. */
  function withWindow(usedPercentage: number, resetsInMs: number): string {
    return JSON.stringify({
      session_id: 'fixture',
      transcript_path: oneTranscript,
      rate_limits: {
        five_hour: {
          used_percentage: usedPercentage,
          resets_at: Math.floor((Date.now() + resetsInMs) / 1000),
        },
      },
    });
  }

  it('shows the measured percentage and the measured reset', () => {
    const r = run(['--statusline', '--root', fixtures], withWindow(40, 3 * oneHour));
    expect(r.code).toBe(0);
    expect(r.out).toContain('5h 40% used');
    expect(r.out).toContain('resets in');
    // Nothing was extrapolated here, so nothing claims to have been.
    expect(r.out).not.toContain('projected');
    expect(r.out.split('\n').filter((l) => l !== '')).toHaveLength(1);
  });

  it('says nothing about limits when the payload carries none', () => {
    // A plain run, an API-key session, or a subscriber before the first API
    // response. The line must not invent a window from local timestamps.
    const r = run(
      ['--statusline', '--root', fixtures],
      JSON.stringify({ session_id: 'fixture', transcript_path: oneTranscript }),
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('used');
    expect(r.out).not.toContain('resets in');
  });

  it('tags a projected exhaustion and leaves the measured half untagged', () => {
    // 90% gone with four of five hours still to run: the pace reaches the cap
    // well before the reset does, which is the state worth interrupting for.
    const r = run(['--statusline', '--root', fixtures], withWindow(90, 4 * oneHour));
    expect(r.code).toBe(0);
    expect(r.out).toContain('5h 90% used');
    expect(r.out).toMatch(/~\S+ to limit \(projected\)/);
  });
});

describe('--limits', () => {
  /**
   * The full window view. It reads the same payload `--statusline` does, so it
   * has the same hard requirement: with no payload there is no window, and the
   * answer is to say so rather than to reconstruct one from local file times.
   */
  function payloadWith(usedPercentage: number, resetsInMs: number): string {
    return JSON.stringify({
      session_id: 'fixture',
      transcript_path: oneTranscript,
      rate_limits: {
        five_hour: {
          used_percentage: usedPercentage,
          resets_at: Math.floor((Date.now() + resetsInMs) / 1000),
        },
      },
    });
  }

  it('says it cannot see a window instead of estimating one', () => {
    const r = run(['--limits', '--root', fixtures], '{"session_id":"x"}');
    // Report-tool contract: exit 0, explain on stderr, print no answer.
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain('cannot see');
    expect(r.err).toContain('statusLine');
  });

  it('separates the measured window from the projected pace in the output', () => {
    const r = run(['--limits', '--root', fixtures], payloadWith(60, 2 * 3_600_000));
    expect(r.code).toBe(0);
    expect(r.out).toContain('measured');
    expect(r.out).toContain('projected');
    expect(r.out).toContain('60% of the 5-hour session limit used');
    // The basis sentence is not optional: without it the projection reads as a
    // second measurement.
    expect(r.out).toContain('straight line');
  });

  it('writes no report file and opens nothing', () => {
    const out = path.join(tmp, 'limits-report.html');
    const r = run(['--limits', '--root', fixtures, '--out', out], payloadWith(10, 3_600_000));
    expect(r.code).toBe(0);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('emits the same figures as JSON, with the two kinds in separate objects', () => {
    const r = run(['--limits', '--json', '--root', fixtures], payloadWith(75, 3_600_000));
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as {
      windows: Array<{
        window: { id: string; usedPercent: number };
        projection: { percentPerHour: number | null };
      }>;
    };
    expect(parsed.windows[0]?.window.id).toBe('five_hour');
    expect(parsed.windows[0]?.window.usedPercent).toBe(75);
    // Measured on `window`, projected on `projection`: a consumer cannot read
    // one for the other by accident.
    expect(parsed.windows[0]).not.toHaveProperty('percentPerHour');
    expect(parsed.windows[0]?.projection.percentPerHour).toBeGreaterThan(0);
  });
});

describe('--statusline --scope today never waits on stdin', () => {
  /**
   * The worst failure this file can catch. `--statusline` runs on every prompt
   * redraw, so a mode that blocks forever does not print a wrong number — it
   * freezes the prompt.
   *
   * `readStdin` is `fs.readFileSync(0)`, which returns only at EOF. A TTY is
   * guarded against, but a PIPE that the host opens and does not close is not:
   * the read parks there for the life of the process. `--scope today` selects
   * its transcripts from the filesystem and never needed the payload, so it had
   * no reason to be exposed to that, and until this it was not — the read lived
   * inside the session branch. Hoisting it to the top of `runStatusline` to
   * share one read with the rate-limit segment handed the cheap scope the
   * expensive scope's failure mode.
   *
   * The cost of the fix, stated because it is a real loss and not a free win:
   * the rate-limit segment rides on that payload, so it is session-scope only.
   * A segment that is sometimes absent beats a prompt that sometimes hangs.
   */
  it('exits instead of blocking on a pipe the host never closes', async () => {
    const child = spawn(
      process.execPath,
      [cli, '--statusline', '--scope', 'today', '--root', fixtures],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Drain both so a full pipe buffer can never be mistaken for the hang.
    child.stdout.resume();
    child.stderr.resume();
    // A partial write and NO end(): exactly what a host that holds stdin open
    // looks like from inside the process.
    child.stdin.write('{"session_id":"x"');

    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, 6_000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    // Not the exit code: the fixture mtimes decide whether anything qualifies
    // as active today, and both 0 and non-zero are correct answers. Exiting at
    // all is the whole assertion.
    expect(exited).toBe(true);
    child.stdin.destroy();
  }, 20_000);
});

describe('--limits --json always emits JSON', () => {
  /**
   * `--help` advertises that `--limits` combines with `--json`, and a JSON mode
   * that prints nothing at all is not a quieter answer — it is a parse error in
   * the caller. The no-window case is the one a script hits most often: an
   * API-key session, Bedrock, Vertex, or a subscriber before the first API
   * response of the session all reach it.
   *
   * The explanation still goes to stderr, where it always went, and the exit
   * code is still 0. Only stdout changes, and it changes from unparseable to
   * an empty window list — which is the answer.
   */
  it('emits an empty window list rather than nothing when no window is visible', () => {
    const r = run(['--limits', '--json', '--root', fixtures], '{"session_id":"x"}');
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as {
      observedAt: number;
      windows: unknown[];
      local: unknown;
    };
    expect(parsed.windows).toEqual([]);
    expect(parsed.local).toBeNull();
    expect(typeof parsed.observedAt).toBe('number');
    // Still said out loud, just not on the channel a caller pipes into a parser.
    expect(r.err).toContain('cannot see');
  });
});
