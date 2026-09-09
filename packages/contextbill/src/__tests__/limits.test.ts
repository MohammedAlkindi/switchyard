import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  bindingWindow,
  formatDuration,
  formatLimitSegment,
  LIMIT_WINDOW_MS,
  projectWindow,
  rateLimitsFromStdin,
  statuslineLimit,
} from '../limits.js';
import type { RateLimitWindow } from '../types.js';

/**
 * The rate-limit window is the one figure in this tool that is NOT derived from
 * a transcript: Claude Code reports it, having read it off the
 * `anthropic-ratelimit-unified-*` response headers. That makes it the only
 * ground truth available here about how much of a subscription window is gone.
 *
 * Everything in this file exists to keep the measured half and the projected
 * half apart. The competing tools in this category estimate the window itself,
 * which is why their numbers disagree with the limits people actually hit. A
 * projection built on a measured window is a different claim, and it is only
 * worth making if a reader can tell which half is which.
 *
 * PAYLOAD SHAPE (Claude Code 2.1.263, read from the statusline payload builder
 * in the shipped binary; see `limits.ts` for the full field list):
 *
 *   "rate_limits": {                    // key absent entirely when no window
 *     "five_hour":   { "used_percentage": number, "resets_at": number },
 *     "seven_day":   { "used_percentage": number, "resets_at": number },
 *     "spend_limit": { "used_percentage": number, "resets_at": number }
 *   }
 *
 * `used_percentage` is 0-100 and may exceed 100. `resets_at` is unix epoch
 * SECONDS. Each sub-key is present only while the API reports that window and
 * its reset has not passed.
 */

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-08T12:00:00Z');

/** A payload carrying just the rate-limit block, as Claude Code writes it. */
function payload(limits: unknown): string {
  return JSON.stringify({
    session_id: 'x',
    transcript_path: '/tmp/a.jsonl',
    rate_limits: limits,
  });
}

function window_(over: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return {
    id: 'five_hour',
    label: '5-hour session limit',
    shortLabel: '5h',
    usedPercent: 50,
    resetsAtMs: NOW + 2.5 * HOUR,
    windowMs: 5 * HOUR,
    ...over,
  };
}

describe('rateLimitsFromStdin', () => {
  it('reads the three documented windows and converts seconds to ms', () => {
    const resets = Math.floor(NOW / 1000) + 900;
    const ws = rateLimitsFromStdin(
      payload({
        five_hour: { used_percentage: 42.5, resets_at: resets },
        seven_day: { used_percentage: 7, resets_at: resets + 60 },
        spend_limit: { used_percentage: 118, resets_at: resets + 120 },
      }),
    );
    expect(ws.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'spend_limit']);
    expect(ws[0]?.usedPercent).toBe(42.5);
    expect(ws[0]?.resetsAtMs).toBe(resets * 1000);
    expect(ws[0]?.windowMs).toBe(LIMIT_WINDOW_MS.five_hour);
    // Above 100 is a real state, not a parse error: the payload's own
    // documentation says a spend limit reads "0-100, above 100 once exceeded".
    expect(ws[2]?.usedPercent).toBe(118);
    // No documented period for a gateway spend limit, so no length is invented.
    expect(ws[2]?.windowMs).toBeNull();
  });

  it('returns nothing when the payload carries no rate_limits key', () => {
    // The common case, and the one the whole feature has to degrade on: a plain
    // CLI run, an API-key session, or a subscriber before the first response.
    expect(rateLimitsFromStdin(payload(undefined))).toEqual([]);
    expect(rateLimitsFromStdin('{"session_id":"x"}')).toEqual([]);
    expect(rateLimitsFromStdin('')).toEqual([]);
    expect(rateLimitsFromStdin('not json')).toEqual([]);
    expect(rateLimitsFromStdin('[1,2,3]')).toEqual([]);
    expect(rateLimitsFromStdin(payload(null))).toEqual([]);
  });

  it('drops a window whose numbers are not numbers, rather than throwing', () => {
    // This payload is not ours and its shape can change under us. A statusline
    // that threw on an unexpected field would break on the next Claude Code
    // release, in someone's prompt.
    const ws = rateLimitsFromStdin(
      payload({
        five_hour: { used_percentage: 'lots', resets_at: 1_790_000_000 },
        seven_day: { used_percentage: 12, resets_at: null },
        spend_limit: { used_percentage: 12, resets_at: 1_790_000_000 },
      }),
    );
    expect(ws.map((w) => w.id)).toEqual(['spend_limit']);
  });

  it('rejects a reset stamp that is not plausible epoch SECONDS', () => {
    // The guard that matters: if that field ever became milliseconds, reading
    // it as seconds would put the reset in the year 58,000 and every derived
    // countdown would be silently enormous rather than visibly wrong.
    expect(
      rateLimitsFromStdin(payload({ five_hour: { used_percentage: 9, resets_at: NOW } })),
    ).toEqual([]);
    expect(
      rateLimitsFromStdin(payload({ five_hour: { used_percentage: 9, resets_at: -5 } })),
    ).toEqual([]);
  });

  it('rejects a negative percentage', () => {
    expect(
      rateLimitsFromStdin(payload({ five_hour: { used_percentage: -1, resets_at: 1_790_000_000 } })),
    ).toEqual([]);
  });
});

describe('projectWindow', () => {
  it('separates what was measured from what was extrapolated', () => {
    // Half of a 5-hour window gone with half the window elapsed: 20 points/hour.
    const p = projectWindow(window_({ usedPercent: 50, resetsAtMs: NOW + 2.5 * HOUR }), NOW);
    expect(p.stale).toBe(false);
    expect(p.msToReset).toBe(2.5 * HOUR);
    expect(p.startedAtMs).toBe(NOW - 2.5 * HOUR);
    expect(p.percentPerHour).toBeCloseTo(20, 10);
    // 50 points left at 20/hour is 2.5 hours, which is exactly the reset.
    expect(p.exhaustedAtMs).toBeCloseTo(NOW + 2.5 * HOUR, 6);
    expect(p.exhaustsBeforeReset).toBe(false);
  });

  it('projects exhaustion before the reset when the pace is ahead of the clock', () => {
    // 80% gone with 4 of 5 hours left: 80 points burnt in the first hour.
    const p = projectWindow(window_({ usedPercent: 80, resetsAtMs: NOW + 4 * HOUR }), NOW);
    expect(p.percentPerHour).toBeCloseTo(80, 10);
    expect(p.exhaustsBeforeReset).toBe(true);
    expect(p.exhaustedAtMs).toBeCloseTo(NOW + 0.25 * HOUR, 6);
  });

  it('projects nothing at all from a window with no documented length', () => {
    // A gateway spend limit publishes a reset but not a period. Deriving one
    // from the gap to the next reset is exactly the estimate this feature
    // exists to avoid making.
    const p = projectWindow(window_({ id: 'spend_limit', windowMs: null }), NOW);
    expect(p.msToReset).toBe(2.5 * HOUR);
    expect(p.startedAtMs).toBeNull();
    expect(p.percentPerHour).toBeNull();
    expect(p.exhaustedAtMs).toBeNull();
    expect(p.exhaustsBeforeReset).toBe(false);
  });

  it('marks a sample whose window already reset as stale and projects nothing', () => {
    const p = projectWindow(window_({ resetsAtMs: NOW - 1000 }), NOW);
    expect(p.stale).toBe(true);
    expect(p.percentPerHour).toBeNull();
    expect(p.exhaustedAtMs).toBeNull();
  });

  it('gives no date for a pace of zero, because zero never arrives', () => {
    const p = projectWindow(window_({ usedPercent: 0 }), NOW);
    expect(p.percentPerHour).toBe(0);
    expect(p.exhaustedAtMs).toBeNull();
    expect(p.exhaustsBeforeReset).toBe(false);
  });

  it('reports an already-exhausted window as exhausted now, not in the past', () => {
    const p = projectWindow(window_({ usedPercent: 104 }), NOW);
    expect(p.exhaustedAtMs).toBe(NOW);
    expect(p.exhaustsBeforeReset).toBe(true);
  });
});

describe('bindingWindow', () => {
  it('picks the window closest to its limit, not the shortest one', () => {
    // The 5-hour window is the one people talk about, but a 7-day window at 95%
    // is what will actually stop the work. Showing the 5-hour one there would
    // be a confident answer to the wrong question.
    const five = window_({ id: 'five_hour', usedPercent: 10 });
    const seven = window_({ id: 'seven_day', usedPercent: 95, windowMs: LIMIT_WINDOW_MS.seven_day });
    expect(bindingWindow([five, seven])?.id).toBe('seven_day');
    expect(bindingWindow([])).toBeNull();
  });

  it('breaks a tie in window order so the line does not flicker', () => {
    const five = window_({ id: 'five_hour', usedPercent: 30 });
    const seven = window_({ id: 'seven_day', usedPercent: 30 });
    expect(bindingWindow([seven, five])?.id).toBe('five_hour');
  });
});

describe('formatDuration', () => {
  it('stays short enough for a prompt line', () => {
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(59_000)).toBe('<1m');
    expect(formatDuration(14 * 60_000)).toBe('14m');
    expect(formatDuration(2 * HOUR + 14 * 60_000)).toBe('2h14m');
    expect(formatDuration(3 * HOUR)).toBe('3h');
    expect(formatDuration(50 * HOUR)).toBe('2d2h');
    expect(formatDuration(48 * HOUR)).toBe('2d');
  });
});

describe('statusline limit segment', () => {
  it('is null when no window was reported, so the line just does not mention limits', () => {
    expect(statuslineLimit([], NOW)).toBeNull();
  });

  it('prints the measured percentage and the measured reset, untagged', () => {
    const l = statuslineLimit([window_({ usedPercent: 42, resetsAtMs: NOW + 2 * HOUR })], NOW);
    expect(l).not.toBeNull();
    expect(l === null ? [] : formatLimitSegment(l)).toEqual(['5h 42% used', 'resets in 2h']);
  });

  it('tags the projected half, and only the projected half', () => {
    // The measured "88% used" and the projected "~15m to limit" are separate
    // segments precisely so the word "projected" cannot attach itself to the
    // measured number by sitting next to it.
    const l = statuslineLimit([window_({ usedPercent: 88, resetsAtMs: NOW + 4 * HOUR })], NOW);
    const parts = l === null ? [] : formatLimitSegment(l);
    expect(parts[0]).toBe('5h 88% used');
    expect(parts[1]).toMatch(/^~\d+m to limit \(projected\)$/);
    expect(parts[0]).not.toContain('projected');
  });

  it('says nothing about a stale window rather than counting down past a reset', () => {
    expect(statuslineLimit([window_({ resetsAtMs: NOW - 1 })], NOW)).toBeNull();
  });
});

describe('the limit view opens no sockets and references nothing external', () => {
  /**
   * The CLI's promise is that it reads files and writes one HTML file, and the
   * rate-limit feature is the first thing in it whose data originates with a
   * vendor API. It would be an easy and disastrous shortcut to fetch that
   * number directly instead of taking it off stdin: it needs a credential, it
   * would run on every prompt, and it would break the one claim on the landing
   * page. So the module is checked for it rather than trusted not to.
   */
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'limits.ts'),
    'utf8',
  );

  it('imports nothing at all, node built-ins included', () => {
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    // Types from ./types.js and nothing else. A `node:` specifier here would
    // also break the browser bundle, exactly as it would in `parse.ts`.
    expect(imports).toEqual(['./types.js']);
  });

  it('names no host, scheme or fetch anywhere', () => {
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest|WebSocket|net\.|node:https?/);
  });
});
