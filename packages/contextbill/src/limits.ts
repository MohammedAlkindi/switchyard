import type {
  LimitProjection,
  LimitWindowId,
  LimitWindowView,
  RateLimitWindow,
} from './types.js';

/**
 * Subscription rate-limit windows, read from the statusline payload.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT AN ESTIMATE
 * ---------------------------------------------------------------------------
 *
 * Every other number this tool prints is derived from a transcript. These are
 * not. Claude Code reads the `anthropic-ratelimit-unified-*` response headers,
 * converts the fraction to a percentage, and writes the result to a statusline
 * command's stdin. So when a window IS present it is the vendor's own count of
 * how much of the window is gone, not a reconstruction of one.
 *
 * That matters because the obvious alternative — inferring a five-hour window
 * from local transcript timestamps — is what every tool in this category does,
 * and it is why their block estimates disagree with the limits people actually
 * hit. A window inferred locally cannot see usage from another machine, from
 * the web app, or from a session whose transcript was deleted, and it cannot
 * see how the vendor weights a request. This module refuses to infer one: when
 * the payload carries no window, the answer is that there is no window to see.
 *
 * ---------------------------------------------------------------------------
 * THE PAYLOAD
 * ---------------------------------------------------------------------------
 *
 * Read out of the shipped Claude Code binary (2.1.263) rather than from a doc
 * page, from the function that builds the statusline input:
 *
 *   let go = {
 *     ...co.five_hour   && { five_hour:   { used_percentage: co.five_hour.utilization   * 100,
 *                                           resets_at: co.five_hour.resets_at } },
 *     ...co.seven_day   && { seven_day:   { used_percentage: co.seven_day.utilization   * 100,
 *                                           resets_at: co.seven_day.resets_at } },
 *     ...gateway && co.overage && { spend_limit: { used_percentage: co.overage.utilization * 100,
 *                                                  resets_at: co.overage.resets_at } }
 *   };
 *   ... (go.five_hour || go.seven_day || go.spend_limit) && { rate_limits: go }
 *
 * Four properties follow from that, and each one is a case below:
 *
 *   1. `rate_limits` is ABSENT, not empty, when no window applies. An API-key
 *      session, Bedrock, Vertex, or a subscriber before the first API response
 *      of the session all produce a payload with no such key.
 *   2. `used_percentage` is 0-100 and MAY EXCEED 100. It is a fraction times a
 *      hundred, and the fraction runs past 1 when usage legitimately overshoots
 *      a window's cap.
 *   3. `resets_at` is unix epoch SECONDS. Claude Code multiplies it by 1000
 *      itself when it schedules its own refresh.
 *   4. A window appears only while its reset is still in the future.
 *
 * None of that is a contract this repo controls, so everything here is parsed
 * defensively: a field of the wrong type drops that window and nothing else,
 * and no exception ever escapes toward a prompt line.
 *
 * Pure by design — no `node:` imports, so this bundles for the browser exactly
 * like `parse.ts` does.
 */

const HOUR_MS = 3_600_000;

/**
 * Documented length of each window.
 *
 * From the window's own name and Claude Code's own description of it ("5-hour
 * session limit", "7-day weekly limit") — a documented fact, not a measurement,
 * which is why every figure derived from it is reported as projected.
 *
 * `spend_limit` is null on purpose. A gateway spend limit publishes a reset and
 * no period, and picking one would be the guess this module exists to refuse.
 */
export const LIMIT_WINDOW_MS: Record<LimitWindowId, number | null> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * 24 * HOUR_MS,
  spend_limit: null,
};

const LABELS: Record<LimitWindowId, { label: string; short: string }> = {
  five_hour: { label: '5-hour session limit', short: '5h' },
  seven_day: { label: '7-day limit', short: '7d' },
  spend_limit: { label: 'gateway spend limit', short: 'spend' },
};

/**
 * Payload order, and the tie-break for `bindingWindow`.
 *
 * Fixed rather than sorted so that two windows sitting at the same percentage
 * cannot make a prompt line alternate between them from keystroke to keystroke.
 */
const ORDER: LimitWindowId[] = ['five_hour', 'seven_day', 'spend_limit'];

/**
 * Plausible range for an epoch-SECONDS stamp: 2001-09-09 to 2096-10-02.
 *
 * The bound that earns its place is the upper one. If `resets_at` ever became
 * milliseconds, reading it as seconds would place the reset in the year 58,000,
 * every countdown would be silently enormous, and no other check here would
 * notice — a window that far out is not stale, not negative and not NaN. This
 * turns that into a dropped window, which the caller reports as "no window".
 */
const MIN_EPOCH_S = 1_000_000_000;
const MAX_EPOCH_S = 4_000_000_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One window out of the payload, or null when it is missing or unusable. */
function windowFrom(id: LimitWindowId, raw: unknown): RateLimitWindow | null {
  if (!isRecord(raw)) return null;
  const used = raw['used_percentage'];
  const resets = raw['resets_at'];
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  if (resets < MIN_EPOCH_S || resets > MAX_EPOCH_S) return null;
  const names = LABELS[id];
  return {
    id,
    label: names.label,
    shortLabel: names.short,
    usedPercent: used,
    resetsAtMs: resets * 1000,
    windowMs: LIMIT_WINDOW_MS[id],
  };
}

/**
 * Pull the rate-limit windows out of the JSON Claude Code writes to a
 * statusline command's stdin.
 *
 * An empty array is the honest answer to every failure here — no payload, a
 * payload that is not JSON, no `rate_limits` key, or a window whose fields are
 * not what this version expects. The caller must say it cannot see a window
 * rather than filling the gap, which is the whole point of the feature.
 */
export function rateLimitsFromStdin(raw: string): RateLimitWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const limits = parsed['rate_limits'];
  if (!isRecord(limits)) return [];

  const out: RateLimitWindow[] = [];
  for (const id of ORDER) {
    const w = windowFrom(id, limits[id]);
    if (w !== null) out.push(w);
  }
  return out;
}

/**
 * Extrapolate one window forward at the pace it has kept so far.
 *
 * The pace is `usedPercent` over the window time elapsed, and the elapsed time
 * comes from the documented window length, not from anything observed. That is
 * the single assumption in this file and it is the reason every field it feeds
 * is reported as projected.
 *
 * Four cases produce no projection at all, and each of them is a case where a
 * number would be worse than a blank:
 *   - no documented window length (a gateway spend limit);
 *   - a reset that has already passed, so the sample is describing a dead window;
 *   - a window that appears not to have started yet, which means the clock here
 *     and the clock behind the header disagree by more than the window;
 *   - a pace of zero, which never reaches 100 however long you extend it.
 */
export function projectWindow(w: RateLimitWindow, now: number): LimitProjection {
  const msToReset = w.resetsAtMs - now;
  const stale = msToReset <= 0;
  const none: LimitProjection = {
    msToReset,
    stale,
    startedAtMs: null,
    percentPerHour: null,
    exhaustedAtMs: null,
    exhaustsBeforeReset: false,
  };
  if (stale || w.windowMs === null) return none;

  const startedAtMs = w.resetsAtMs - w.windowMs;
  const elapsedMs = now - startedAtMs;
  if (elapsedMs <= 0) return none;

  const percentPerHour = w.usedPercent / (elapsedMs / HOUR_MS);

  // Already past the cap. The pace figure is still real and still worth
  // printing; the exhaustion "forecast" is simply the present.
  if (w.usedPercent >= 100) {
    return {
      msToReset,
      stale,
      startedAtMs,
      percentPerHour,
      exhaustedAtMs: now,
      exhaustsBeforeReset: true,
    };
  }
  if (percentPerHour <= 0) {
    return { ...none, startedAtMs, percentPerHour };
  }

  const exhaustedAtMs = now + ((100 - w.usedPercent) / percentPerHour) * HOUR_MS;
  return {
    msToReset,
    stale,
    startedAtMs,
    percentPerHour,
    exhaustedAtMs,
    exhaustsBeforeReset: exhaustedAtMs < w.resetsAtMs,
  };
}

/**
 * The window a reader should be shown first: the one closest to its limit.
 *
 * Not the shortest one. The five-hour window is the one people talk about, but
 * a seven-day window at 95% is what will actually stop the work, and showing
 * the five-hour one there answers the wrong question confidently. Ties fall
 * back to payload order so the choice is stable between invocations.
 */
export function bindingWindow(windows: readonly RateLimitWindow[]): RateLimitWindow | null {
  let best: RateLimitWindow | null = null;
  for (const w of windows) {
    if (best === null) {
      best = w;
      continue;
    }
    if (w.usedPercent > best.usedPercent) best = w;
    // Tie-broken by ORDER rather than by array position, so the answer does not
    // depend on how the caller happened to collect the windows.
    else if (w.usedPercent === best.usedPercent && ORDER.indexOf(w.id) < ORDER.indexOf(best.id)) {
      best = w;
    }
  }
  return best;
}

/** Every window paired with its projection, in payload order. */
export function limitViews(
  windows: readonly RateLimitWindow[],
  now: number,
): LimitWindowView[] {
  return windows.map((window) => ({ window, projection: projectWindow(window, now) }));
}

/**
 * A duration in the widest form that still fits a prompt: `2h14m`, `14m`, `2d`.
 *
 * Under a minute reads `<1m` rather than `0m`, because a countdown that shows
 * zero and keeps going looks broken.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** What a statusline shows about limits: one window, reduced to three numbers. */
export interface StatuslineLimit {
  shortLabel: string;
  /** MEASURED. */
  usedPercent: number;
  /** MEASURED, against the local clock. */
  msToReset: number;
  /** PROJECTED. Non-null only when the limit is projected to arrive first. */
  msToExhaustion: number | null;
}

/**
 * The limit facts for a prompt line, or null when there is nothing honest to
 * put there — no window at all, or only windows whose reset has passed.
 */
export function statuslineLimit(
  windows: readonly RateLimitWindow[],
  now: number,
): StatuslineLimit | null {
  const w = bindingWindow(windows);
  if (w === null) return null;
  const p = projectWindow(w, now);
  if (p.stale) return null;
  return {
    shortLabel: w.shortLabel,
    usedPercent: w.usedPercent,
    msToReset: p.msToReset,
    msToExhaustion:
      p.exhaustsBeforeReset && p.exhaustedAtMs !== null
        ? Math.max(0, p.exhaustedAtMs - now)
        : null,
  };
}

/**
 * Two statusline segments: what was measured, then what was projected.
 *
 * They are separate strings rather than one because the caller joins segments
 * with a separator, and that separator is what stops "(projected)" from
 * appearing to qualify the measured percentage it would otherwise sit beside.
 * The tag is eleven characters on a line where width is expensive; it stays
 * because an untagged forecast next to a measurement is exactly the blur this
 * feature was built to avoid.
 */
export function formatLimitSegment(l: StatuslineLimit): string[] {
  const measured = `${l.shortLabel} ${Math.round(l.usedPercent)}% used`;
  if (l.msToExhaustion !== null) {
    return [measured, `~${formatDuration(l.msToExhaustion)} to limit (projected)`];
  }
  return [measured, `resets in ${formatDuration(l.msToReset)}`];
}
