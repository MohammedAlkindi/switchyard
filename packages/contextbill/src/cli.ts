#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregate, monthlyProjection, planUtilization } from './aggregate.js';
import { cacheWriteMultiplier, priceAll, usd } from './cost.js';
import {
  bindingWindow,
  formatDuration,
  formatLimitSegment,
  limitViews,
  rateLimitsFromStdin,
  statuslineLimit,
} from './limits.js';
import type { StatuslineLimit } from './limits.js';
import { redactProject } from './privacy.js';
import { pricedProviders, renderReport } from './report.js';
import { listTranscripts, scanCodexCorpus, scanCorpus, scanFile } from './scan.js';
import type {
  CacheTtl,
  LimitReport,
  LimitWindowView,
  LocalWindowSpend,
  PlanTable,
  PriceTable,
  RawUsage,
  Report,
  SessionStat,
  SourceSummary,
  TranscriptSource,
  UnreadableFile,
} from './types.js';

/**
 * The only module here that touches the filesystem or the process. Everything
 * it calls is pure, which is what makes the rest of the codebase testable
 * without fixtures on disk.
 *
 * Two operational rules inherited from the reference implementation, both
 * deliberate:
 *   - Transcripts are opened read-only. Never write into the directory being
 *     measured; a live session may hold those files.
 *   - Always exit 0. This is a reporting tool; failing a caller's pipeline
 *     because a measurement did not work is worse than printing nothing.
 *     `--statusline` is the single exception, and it exists for the same
 *     reason the rule does: its output lands in someone's prompt, where a
 *     failure that says nothing beats one that explains itself. See
 *     `runStatusline`.
 */

const HELP = `contextbill — what your coding agents cost at API rates

USAGE
  contextbill [options]

OPTIONS
  --root <dir>       Claude Code transcript root. Default: ~/.claude/projects
  --source <which>   Which agents to read: claude (default), codex, or all.
                     prices.json carries Anthropic and OpenAI rates, so Codex
                     turns are priced in dollars exactly as Claude Code's are.
                     A model with no entry in that table is counted, named,
                     and kept out of every dollar figure — never guessed at.
                     Adding a source never changes what your Claude Code
                     usage costs.
  --codex-root <dir> OpenAI Codex CLI rollout root. Default: ~/.codex/sessions
                     Read only when --source includes codex. It is a separate
                     flag from --root on purpose: the two agents keep their
                     transcripts in different places and in different layouts.
  --out <file>       Report path. Default: ./contextbill-report.html
  --cache-ttl <ttl>  Cache-write billing rate: 5m (default) or 1h.
                     Transcripts don't record this. 5m is the conservative
                     choice — if your client used 1h caching, the real cost
                     is higher than reported.
  --plan <id>        Also report what your subscription returned: the
                     API-equivalent value of the usage, the plan's monthly
                     price, and the break-even multiple, month by month.
                     Run with an unknown id to list the supported ones.
                     The multiple is computed over WHOLE calendar months only —
                     a partial month charged against a full month's fee reports
                     a multiple that is too low, so those months are shown and
                     excluded rather than folded in.
  --json             Print the report as JSON to stdout, write no file.
  --statusline       Print ONE short line to stdout and write no file, for use
                     as a Claude Code statusLine command. Reads the JSON Claude
                     Code writes to the command's stdin and prices the
                     transcript named there. Exits non-zero and prints nothing
                     if it cannot, because a stack trace inside someone's prompt
                     is worse than a missing line.
  --limits           Report your subscription's rate-limit windows: how much of
                     each is consumed, when it resets, and — labelled
                     separately — the pace that implies. Reads the same JSON
                     Claude Code writes to a statusLine command's stdin, which
                     is where those windows arrive; they come from the API, so
                     they are measured rather than inferred from local files.
                     Run without that payload and it says it cannot see a
                     window. It never estimates one: a window guessed from local
                     transcripts cannot see usage from another machine, from the
                     web app, or from a deleted transcript, and that is exactly
                     why guessed ones disagree with the limits you actually hit.
                     Writes no file. Combines with --json.
  --scope <which>    What --statusline measures: session (default) or today.
                     session prices one transcript — the one on stdin, or the
                     most recently modified under --root. today prices every
                     transcript modified since local midnight; a session that
                     began yesterday and continued today is counted in FULL,
                     so it is labelled "active today" rather than "today".
                     Scoping exists because a statusline redraws constantly
                     and a full scan reads the whole corpus. Session scope
                     reads one transcript, today scope reads the files touched
                     since local midnight.
                     Only session scope reads stdin. The rate-limit segment
                     arrives on that payload, so today scope does not carry it,
                     and in exchange today never waits on a pipe a host leaves
                     open.
                     Ignored unless --statusline is given.
  --project <slug>   Only transcripts whose project matches this text. Matches
                     a substring, case-insensitively, so --project acme finds
                     C--Users-you-work-acme. Without it, every project is read.
  --top <n>          Sessions in the "most expensive" table. Default: 20.
  --show-paths       Show full project directory slugs. Off by default: those
                     slugs encode your OS username and directory tree, and the
                     report is meant to be shared.
  --version          Print version.
  --help             This text.

Every dollar figure is API-equivalent: what this usage would cost metered at a
vendor's published first-party API rates — Anthropic's for Claude Code usage,
OpenAI's for Codex. If you are on a subscription you paid a flat fee instead, so
these numbers value the usage rather than restate your invoice.

contextbill reads transcripts and writes one HTML file. It opens no sockets.
`;

/** Which transcript sources to read. */
type SourceSelection = 'claude' | 'codex' | 'all';

/** What `--statusline` measures. See `runStatusline` for why it is scoped. */
export type StatuslineScope = 'session' | 'today';

/** Display names for the per-source table, kept next to the selection type. */
const SOURCE_LABELS: Record<TranscriptSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'OpenAI Codex CLI',
};

export interface Options {
  root: string;
  /** Codex rollout root. Read only when `source` includes codex. */
  codexRoot: string;
  /** Which agents to read. Default `claude`, so behaviour is unchanged. */
  source: SourceSelection;
  out: string;
  /** Substring filter on the project slug. Empty means every project. */
  project: string;
  /** Plan id to value usage against. Empty means no plan report. */
  plan: string;
  ttl: CacheTtl;
  json: boolean;
  /** One-line statusline output. Mutually exclusive with writing a report. */
  statusline: boolean;
  /** Rate-limit window report. Reads the statusline payload; writes no file. */
  limits: boolean;
  /** What `--statusline` measures. Meaningless without it. */
  scope: StatuslineScope;
  top: number;
  showPaths: boolean;
  help: boolean;
  version: boolean;
  /** Flags we did not recognise. Surfaced so a typo is not silently ignored. */
  unknown: string[];
}

export function parseArgs(argv: readonly string[], home: string): Options {
  const opts: Options = {
    root: path.join(home, '.claude', 'projects'),
    codexRoot: path.join(home, '.codex', 'sessions'),
    source: 'claude',
    out: path.resolve('contextbill-report.html'),
    project: '',
    plan: '',
    ttl: '5m',
    json: false,
    statusline: false,
    limits: false,
    scope: 'session',
    top: 20,
    showPaths: false,
    help: false,
    version: false,
    unknown: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const [flag, inlineValue] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const next = (): string | undefined => inlineValue ?? argv[++i];

    switch (flag) {
      case '--root': {
        const v = next();
        if (v !== undefined) opts.root = path.resolve(v);
        break;
      }
      case '--codex-root': {
        const v = next();
        if (v !== undefined) opts.codexRoot = path.resolve(v);
        break;
      }
      case '--source': {
        // An unrecognised value is reported like an unrecognised flag rather
        // than silently falling back: "--source codx" quietly reading only
        // Claude Code looks exactly like Codex contributing nothing.
        const v = next()?.trim().toLowerCase();
        if (v === 'claude' || v === 'claude-code') opts.source = 'claude';
        else if (v === 'codex') opts.source = 'codex';
        else if (v === 'all' || v === 'both') opts.source = 'all';
        else if (v !== undefined) opts.unknown.push(`--source ${v}`);
        break;
      }
      case '--out': {
        const v = next();
        if (v !== undefined) opts.out = path.resolve(v);
        break;
      }
      case '--project': {
        const v = next();
        if (v !== undefined) opts.project = v;
        break;
      }
      case '--plan': {
        // Kept verbatim and validated against the price table in main(), not
        // here: parseArgs has no table to check against, and silently dropping
        // an unrecognised id would report no plan at all while looking like it
        // had honoured the flag.
        const v = next();
        if (v !== undefined) opts.plan = v.trim().toLowerCase();
        break;
      }
      case '--cache-ttl': {
        const v = next();
        if (v === '1h' || v === '5m') opts.ttl = v;
        break;
      }
      case '--top': {
        const v = next();
        const parsedTop = v === undefined ? NaN : Number.parseInt(v, 10);
        if (Number.isFinite(parsedTop) && parsedTop > 0) opts.top = parsedTop;
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--statusline':
        opts.statusline = true;
        break;
      case '--limits':
        opts.limits = true;
        break;
      case '--scope': {
        // Same rule as --source: an unrecognised value is reported, never
        // silently defaulted. "--scope toady" quietly measuring one session
        // looks exactly like a quiet day.
        const v = next()?.trim().toLowerCase();
        if (v === 'session' || v === 'today') opts.scope = v;
        else if (v !== undefined) opts.unknown.push(`--scope ${v}`);
        break;
      }
      case '--show-paths':
        opts.showPaths = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
      case '-v':
        opts.version = true;
        break;
      default:
        // Anything flag-shaped we do not know is a typo, not a no-op.
        if (flag !== undefined && flag.startsWith('-')) opts.unknown.push(flag);
        break;
    }
  }
  return opts;
}

function loadPriceTable(): PriceTable {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli.js -> ../prices.json at the package root.
  const candidates = [
    path.join(here, '..', 'prices.json'),
    path.join(here, 'prices.json'),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')) as PriceTable;
    } catch {
      continue;
    }
  }
  throw new Error('prices.json not found next to the contextbill package');
}

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const raw = fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Write via temp + rename so a reader never sees a half-written report. */
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Split the corpus by the agent that wrote it, pricing each half separately.
 *
 * Built here rather than in `aggregate.ts` because it exists for a presentation
 * problem: the aggregate total is correct and its meaning is ambiguous once the
 * corpus mixes an agent this repo can price with one it cannot. Every Codex turn
 * lands in `report.turns` and `report.usage` and contributes $0 to
 * `report.cost`, so a reader who does not notice `unpricedModelsSeen` reads a
 * dollar figure as covering tokens it does not cover.
 *
 * The fix is to state it, not to fix it: there are no OpenAI rates in
 * `prices.json`, and adding invented ones would price real usage confidently and
 * wrongly with nothing failing. So this reports the token counts — which ARE
 * measured — beside a dollar column that is honestly blank.
 *
 * Prices each source over its own model entries with the same `priceAll` the
 * aggregate uses, so the source rows sum back to `report.cost.total` exactly.
 */
export function summariseSources(
  stats: readonly SessionStat[],
  table: PriceTable,
  ttl: CacheTtl,
): SourceSummary[] {
  const order: TranscriptSource[] = ['claude-code', 'codex'];
  const acc = new Map<TranscriptSource, SourceSummary>();

  for (const stat of stats) {
    const source = stat.source ?? 'claude-code';
    let row = acc.get(source);
    if (row === undefined) {
      row = {
        source,
        label: SOURCE_LABELS[source],
        transcripts: 0,
        sessions: 0,
        turns: 0,
        usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
        usd: 0,
        unpricedModels: [],
        unpricedTurns: 0,
        fullyPriced: true,
      };
      acc.set(source, row);
    }

    const priced = priceAll(stat.byModel, table, ttl);
    row.transcripts += 1;
    if (!stat.isSubagent) row.sessions += 1;
    row.turns += stat.turns;
    row.usage.input += stat.usage.input;
    row.usage.cacheWrite += stat.usage.cacheWrite;
    row.usage.cacheRead += stat.usage.cacheRead;
    row.usage.output += stat.usage.output;
    row.usd += priced.cost.total;

    // Counted from the per-model entries rather than from `stat.turns`, because
    // a session can straddle a priced and an unpriced model and only part of it
    // is missing dollars.
    const unpriced = new Set(priced.unpriced);
    for (const entry of stat.byModel) {
      if (unpriced.has(entry.model)) row.unpricedTurns += entry.turns;
    }
    for (const model of priced.unpriced) {
      if (!row.unpricedModels.includes(model)) row.unpricedModels.push(model);
    }
  }

  const rows = [...acc.values()];
  for (const row of rows) {
    row.unpricedModels.sort();
    row.fullyPriced = row.unpricedTurns === 0;
  }
  return rows.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
}

/** Total tokens across the four billed classes. */
function totalTokens(usage: RawUsage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead + usage.output;
}

/* -------------------------------------------------------------------------- *
 * Statusline mode
 *
 * Claude Code runs a statusLine command on every prompt, so this path has a
 * latency budget the rest of the CLI does not. The ordering is structural: a
 * full scan reads every transcript in the corpus, `today` reads only the files
 * touched since local midnight, and `session` reads exactly one. Only the last
 * is a thing to do between keystrokes, which is why it is the default and
 * `today` has to be asked for.
 *
 * No timing table here on purpose. One stood in README until 2026-09-09 and was
 * removed because it failed to reproduce twice on the machine that produced it:
 * the `node -e ""` floor row alone moved 1.9x, and no change to this program can
 * move that. See README, "Use it as a statusline", for the retraction.
 *
 * Two rules that differ from every other mode here, both deliberate:
 *   - It writes no file. `--out` is not consulted.
 *   - It exits NON-ZERO and prints nothing when it cannot answer, instead of
 *     obeying the always-exit-0 contract at the bottom of this file. That
 *     contract exists so a reporting tool never fails a caller's pipeline; a
 *     statusline has the opposite failure mode, because its stdout is pasted
 *     into someone's prompt. Claude Code hides a statusline whose command
 *     fails, so a silent non-zero exit degrades to no line at all.
 * -------------------------------------------------------------------------- */

/** The scope word printed at the end of the line. */
const SCOPE_LABELS: Record<StatuslineScope, string> = {
  session: 'session',
  // Not "today": the filter is file mtime, so a session that started yesterday
  // and continued today is counted in full. "active today" is what is actually
  // being measured, and the label says so rather than implying a daily total.
  today: 'active today',
};

/** What the statusline line is rendered from. Pure input, so it is testable. */
export interface StatuslineFacts {
  usd: number;
  turns: number;
  tokens: number;
  scope: StatuslineScope;
  /** How many model ids carried no rate. Their tokens are in `tokens`. */
  unpricedModels: number;
  /**
   * Transcripts that were selected and could not be read. Their turns and
   * dollars are in NEITHER figure above.
   *
   * Required rather than optional so the compiler asks the question. A caller
   * that forgets it reports a total which silently excludes files, which is the
   * defect this field was added to fix.
   */
  unreadable: number;
  /**
   * The subscription rate-limit window, when Claude Code reported one. Null on
   * every other run, and the line then says nothing about limits rather than
   * inferring a window from local file times.
   */
  limit: StatuslineLimit | null;
}

/**
 * Token counts, short enough for a prompt line. Two significant-ish digits
 * under 10 units, none above, because the width matters more than the digits.
 */
export function compactTokens(n: number): string {
  const scale = (v: number, suffix: string): string =>
    `${v < 10 ? v.toFixed(1) : Math.round(v)}${suffix}`;
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return scale(n / 1_000, 'K');
  // A billion is reachable on a real corpus, not a theoretical guard: --scope
  // today measured 3,960M here on an ordinary day, and "3960M" is both wider
  // and harder to read than "4.0B".
  if (n < 1_000_000_000) return scale(n / 1_000_000, 'M');
  return scale(n / 1_000_000_000, 'B');
}

/**
 * One line, no newline, no colour.
 *
 * "API-equiv" is the compact form of the sentence the report and the terminal
 * summary both spell out: these dollars are what the usage would cost metered
 * at published API rates, not what a subscription was charged. It is two words
 * wide and it is not droppable — a bare dollar figure in a prompt reads as a
 * bill, which is the single misreading this whole tool exists to prevent.
 */
export function formatStatusline(f: StatuslineFacts): string {
  const parts = [
    `${usd(f.usd)} API-equiv`,
    `${f.turns.toLocaleString('en-US')} turns`,
    `${compactTokens(f.tokens)} tok`,
    SCOPE_LABELS[f.scope],
  ];
  // Stated, not folded in as zero: with an unpriced model in the corpus the
  // token count covers more than the dollar figure does.
  if (f.unpricedModels > 0) parts.push(`${f.unpricedModels} unpriced`);
  // Same rule, different cause. A file that could not be read is not a file
  // with nothing in it, and the figures above are short by whatever it held.
  if (f.unreadable > 0) parts.push(`${f.unreadable} unread`);
  // Last, and in two segments: the measured percentage and, when there is one,
  // the projected time to the limit. They stay separate strings so the
  // separator keeps "(projected)" from reading as a qualifier on the
  // measurement standing next to it.
  if (f.limit !== null) parts.push(...formatLimitSegment(f.limit));
  return parts.join(' · ');
}

/**
 * Pull the transcript path out of the JSON Claude Code writes to a statusline
 * command's stdin.
 *
 * Everything about that payload is treated as untrusted: it is parsed inside a
 * try, only `transcript_path` is read, and a non-string is the same as absent.
 * A statusline that threw on an unexpected field would break on the next
 * version of the payload, which is not a thing this repo controls.
 */
export function transcriptPathFromStdin(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { transcript_path?: unknown };
    const p = parsed.transcript_path;
    return typeof p === 'string' && p.trim() !== '' ? p : null;
  } catch {
    return null;
  }
}

/** Read stdin to the end, synchronously. Empty when there is nothing to read. */
function readStdin(): string {
  // A TTY stdin never ends, so reading it would hang the prompt forever. Under
  // Claude Code stdin is a pipe carrying the payload and this is false.
  if (process.stdin.isTTY === true) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Newest `.jsonl` under `root` by mtime, or null if there are none. */
function newestTranscript(root: string): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const file of listTranscripts(root)) {
    try {
      const ms = fs.statSync(file).mtimeMs;
      if (ms > newestMs) {
        newestMs = ms;
        newest = file;
      }
    } catch {
      continue;
    }
  }
  return newest;
}

/** Local midnight before `now`, as epoch ms. */
function localMidnight(now: Date): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

/**
 * Transcripts under `root` modified since `cutoffMs`.
 *
 * mtime, not content: a transcript that began before the cutoff and was
 * appended to after it is selected, and then counted in FULL. That is why the
 * `today` scope is labelled "active today" and why the rate-limit view calls
 * its local figure "transcripts touched since the window opened". The
 * approximation is cheap and it is stated everywhere it reaches a reader.
 */
function transcriptsModifiedSince(root: string, cutoffMs: number): string[] {
  const out: string[] = [];
  for (const file of listTranscripts(root)) {
    try {
      if (fs.statSync(file).mtimeMs >= cutoffMs) out.push(file);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Read one transcript for the statusline.
 *
 * The project label is taken from the parent directory rather than inferred
 * from a corpus layout: nothing on this path renders a project, and a
 * `detectLayout` pass would mean listing the whole root to answer a question
 * the output does not ask.
 */
function statTranscript(file: string): SessionStat | null {
  // The fifth argument is the point. Without it `scanFile` answers a read error
  // with an EMPTY stat, and this mode then printed "$0.00 API-equiv / 0 turns"
  // for a transcript it never opened — a confident wrong number, in a prompt.
  // `scanCorpus` has always used this callback; this path used to discard it.
  let failed = false;
  const stat = scanFile(file, 2, path.basename(path.dirname(file)) || 'unknown', 2, () => {
    failed = true;
  });
  return failed ? null : stat;
}

/**
 * Print the statusline. Returns the process exit code: 0 printed a line,
 * 1 printed nothing.
 */
export function runStatusline(opts: Options, now: Date = new Date()): number {
  const table = loadPriceTable();
  const stats: SessionStat[] = [];
  let unreadable = 0;

  // Read ONLY on the branch that cannot answer without it. `readStdin` is a
  // synchronous read to EOF, so a host that opens the pipe and never closes it
  // parks this process for its whole lifetime — and this process is a prompt
  // redraw, so parking it freezes the prompt rather than printing a wrong
  // number. The TTY guard inside `readStdin` covers a terminal; nothing covers
  // an open pipe.
  //
  // `session` scope has to carry that risk: the payload is what NAMES the
  // transcript, and the fallback is a guess between concurrent sessions. `today`
  // scope does not — it selects from the filesystem — and it never touched
  // stdin until one shared read was hoisted to the top of this function so the
  // rate-limit segment could ride along on both scopes. That handed the cheap
  // scope the expensive scope's failure mode, which is the worse trade.
  //
  // The cost, stated rather than hidden: the rate-limit windows arrive on that
  // same payload, so the limit segment is session-scope only. A segment that is
  // sometimes absent beats a prompt that sometimes hangs.
  let payload = '';

  if (opts.scope === 'today') {
    for (const file of transcriptsModifiedSince(opts.root, localMidnight(now))) {
      const stat = statTranscript(file);
      if (stat === null) unreadable += 1;
      else stats.push(stat);
    }
  } else {
    // The path Claude Code hands us wins. Falling back to the newest file under
    // --root is for running the command by hand, and it is a guess: two
    // sessions writing at once make "newest" a race. It is only ever a
    // fallback, never a correction to a path that was supplied.
    payload = readStdin();
    const fromStdin = transcriptPathFromStdin(payload);
    const file =
      fromStdin !== null && fs.existsSync(fromStdin) ? fromStdin : newestTranscript(opts.root);
    if (file !== null) {
      const stat = statTranscript(file);
      if (stat === null) unreadable += 1;
      else stats.push(stat);
    }
  }

  // Nothing to measure at all — an unreadable root, or a --root pointing
  // somewhere with no transcripts under it. Say nothing; a statusline is not
  // the place to explain a configuration problem.
  //
  // A transcript that was named and could not be READ lands here too, and that
  // is the fix for the bigger of the two failures: the mode used to print a
  // confident zero instead. There is deliberately no fallback to another
  // session at that point — reporting a different session's numbers under this
  // session's prompt is worse than reporting none.
  if (stats.length === 0) return 1;

  const priced = priceAll(
    stats.flatMap((s) => s.byModel),
    table,
    opts.ttl,
  );
  const usage = stats.reduce(
    (acc, s) => ({
      input: acc.input + s.usage.input,
      cacheWrite: acc.cacheWrite + s.usage.cacheWrite,
      cacheRead: acc.cacheRead + s.usage.cacheRead,
      output: acc.output + s.usage.output,
    }),
    { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  );

  process.stdout.write(
    `${formatStatusline({
      usd: priced.cost.total,
      turns: stats.reduce((n, s) => n + s.turns, 0),
      tokens: totalTokens(usage),
      scope: opts.scope,
      unpricedModels: priced.unpriced.length,
      unreadable,
      limit: statuslineLimit(rateLimitsFromStdin(payload), now.getTime()),
    })}\n`,
  );
  return 0;
}

/* -------------------------------------------------------------------------- *
 * Rate-limit mode
 *
 * `--limits` answers three questions about a subscription window: how much of
 * it is gone, when it resets, and what the pace so far implies. The first two
 * are MEASURED — Claude Code read them off the API's own rate-limit headers and
 * wrote them to this command's stdin. The third is PROJECTED, and the output
 * keeps them in separate gutters because a reader who cannot tell them apart is
 * exactly the reader these numbers would mislead.
 *
 * The tools this competes with estimate the window itself from local timestamps
 * and then present the estimate as a measurement. That is why their block
 * predictions disagree with the limits people actually hit: a local estimate
 * cannot see usage from a second machine, from the web app, or from a session
 * whose transcript was deleted, and it cannot see how the vendor weights a
 * request. This mode refuses to make that estimate. With no payload there is no
 * window, and it says so.
 * -------------------------------------------------------------------------- */

/** UTC to the minute. Locale-free, so two machines print the same instant. */
function utcStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * What the local transcripts spent since an instant, priced the usual way.
 *
 * Selection is by mtime, so a transcript that opened before `sinceMs` and was
 * appended to after it is counted in full. The caller says so in the line it
 * prints; see `transcriptsModifiedSince`.
 */
function localSpendSince(
  root: string,
  sinceMs: number,
  now: number,
  windowId: LocalWindowSpend['windowId'],
  table: PriceTable,
  ttl: CacheTtl,
): { spend: LocalWindowSpend; unreadable: number } | null {
  if (!fs.existsSync(root)) return null;

  const stats: SessionStat[] = [];
  let unreadable = 0;
  for (const file of transcriptsModifiedSince(root, sinceMs)) {
    const stat = statTranscript(file);
    if (stat === null) unreadable += 1;
    else stats.push(stat);
  }

  const priced = priceAll(
    stats.flatMap((s) => s.byModel),
    table,
    ttl,
  );
  const hours = Math.max((now - sinceMs) / 3_600_000, 1 / 60);
  return {
    spend: {
      windowId,
      sinceMs,
      transcripts: stats.length,
      turns: stats.reduce((n, s) => n + s.turns, 0),
      usd: priced.cost.total,
      usdPerHour: priced.cost.total / hours,
    },
    unreadable,
  };
}

/** The two-line block for one window. Measured first, projected second. */
function renderLimitWindow(view: LimitWindowView, now: number): string[] {
  const { window: w, projection: p } = view;
  const lines: string[] = [];

  if (p.stale) {
    // Claude Code only emits a window whose reset is still ahead, so this is a
    // replayed or hand-fed payload. Saying it is stale beats counting down
    // through a reset that has already happened.
    lines.push(
      `  measured   ${Math.round(w.usedPercent)}% of the ${w.label} used — that window ` +
        `reset at ${utcStamp(w.resetsAtMs)}, so this reading is stale`,
    );
    return lines;
  }

  lines.push(
    `  measured   ${Math.round(w.usedPercent)}% of the ${w.label} used — resets in ` +
      `${formatDuration(p.msToReset)} (${utcStamp(w.resetsAtMs)})`,
  );

  if (p.percentPerHour === null) {
    lines.push(
      '             no window length is documented for this limit, so no pace is projected',
    );
    return lines;
  }
  const pace = `${p.percentPerHour.toFixed(1)} points/hour since that window opened`;
  if (p.exhaustedAtMs === null) {
    lines.push(`  projected  ${pace} — nothing to extrapolate from that`);
  } else if (p.exhaustsBeforeReset) {
    // Split over two lines: this is the state worth acting on, and it is the
    // one place the block would otherwise run past a terminal width.
    lines.push(
      `  projected  ${pace}`,
      `             100% around ${utcStamp(p.exhaustedAtMs)} — ` +
        `${formatDuration(Math.max(0, p.exhaustedAtMs - now))} from now, before the reset`,
    );
  } else {
    lines.push(`  projected  ${pace}; at that pace the window resets before it fills`);
  }
  return lines;
}

/**
 * Print the rate-limit view. Returns the process exit code, which is always 0:
 * unlike `--statusline` this output is read by a person at a terminal, so the
 * always-exit-0 contract at the top of this file applies to it unchanged.
 */
export function runLimits(opts: Options, now: number = Date.now()): number {
  const windows = rateLimitsFromStdin(readStdin());

  // The honest degradation, and the reason the feature is worth having: no
  // payload means no window, and no window means no answer. Estimating one from
  // local transcript times here would produce a plausible number that is wrong
  // in a way nothing could catch.
  if (windows.length === 0) {
    process.stderr.write(
      'contextbill: cannot see a rate-limit window.\n' +
        '  Those windows come from the API, and Claude Code passes them to a statusLine\n' +
        "  command on stdin. Nothing readable arrived there, so there is nothing to report.\n" +
        '  Wire this up as a statusLine command, or pipe that JSON in:\n' +
        '    "statusLine": { "type": "command", "command": "contextbill --limits" }\n' +
        '  There is no window on an API-key, Bedrock or Vertex session, and none for a\n' +
        '  subscriber until the first API response of the session. contextbill does not\n' +
        '  estimate one from your transcripts: a local guess cannot see usage from another\n' +
        '  machine or from the web app, and a confident wrong window is the failure this\n' +
        '  whole tool exists to avoid.\n',
    );
    // A JSON mode always emits JSON. `--help` advertises that --limits combines
    // with --json, and printing nothing at all here is not a quieter answer — it
    // is a parse error in whatever the caller piped this into. The no-window
    // case is the one a script meets most often: an API-key, Bedrock or Vertex
    // session, and every subscriber session before its first API response.
    //
    // An empty window list IS the answer, and it is the same shape a caller
    // already handles. The explanation stays on stderr, where it cannot corrupt
    // the document on stdout.
    if (opts.json) {
      const empty: LimitReport = { observedAt: now, windows: [], local: null };
      process.stdout.write(`${JSON.stringify(empty, null, 2)}\n`);
    }
    return 0;
  }

  const table = loadPriceTable();
  const views = limitViews(windows, now);
  const binding = bindingWindow(windows);
  const bindingView = views.find((v) => v.window === binding) ?? null;

  // Local spend is measured against the binding window only. Repeating it for a
  // seven-day window would restate most of the corpus and say nothing new.
  const started = bindingView?.projection.startedAtMs ?? null;
  const local =
    bindingView !== null && started !== null
      ? localSpendSince(opts.root, started, now, bindingView.window.id, table, opts.ttl)
      : null;

  const report: LimitReport = {
    observedAt: now,
    windows: views,
    local: local?.spend ?? null,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const lines: string[] = ['', '  Rate-limit windows, read from the statusline payload', ''];
  for (const view of views) {
    lines.push(...renderLimitWindow(view, now));
    if (view.window === bindingView?.window && started !== null && local === null) {
      // The window is fine; the transcript root is not. Saying which half is
      // missing beats leaving the local line quietly absent, which reads as
      // "nothing was spent" rather than "nothing was read".
      lines.push(
        `             no transcripts read for the local half — ${opts.root} does not exist`,
      );
    }
    if (local !== null && view.window === bindingView?.window) {
      const s = local.spend;
      lines.push(
        `  measured   ${usd(s.usd)} API-equivalent across ${s.turns.toLocaleString('en-US')} turn(s) in ` +
          `${s.transcripts.toLocaleString('en-US')} transcript(s) touched`,
        `             since that window opened — ${usd(s.usdPerHour)}/hour` +
          (local.unreadable > 0
            ? `, with ${local.unreadable} file(s) excluded because they could not be read`
            : ''),
      );
    }
    lines.push('');
  }

  lines.push(
    '  Measured figures are the count the API itself returned, arriving on the JSON',
    '  Claude Code writes to the stdin of a statusLine command. Projected figures are a',
    '  straight line through that count — the pace so far, extended — and the start of',
    '  each window is derived from its documented length. Usage is bursty, so read a',
    '  projection as a pace and never as a promise.',
    '',
    '  The dollar figures are API-equivalent and are NOT the quantity the percentages',
    '  measure: a plan window is weighted by rules this tool cannot see. They sit beside',
    '  the official numbers, never as a check on them.',
    '',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}


function main(): number {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
  const opts = parseArgs(process.argv.slice(2), home);

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  if (opts.unknown.length > 0 && !opts.statusline) {
    process.stderr.write(
      `contextbill: ignoring unrecognised flag(s): ${opts.unknown.join(', ')}\n` +
        'Run "contextbill --help" for the supported options.\n\n',
    );
  }

  // Before every other branch: statusline reads one transcript, writes one line
  // and returns. None of the corpus-wide diagnostics below apply to it, and
  // each of them writes to stderr, which a statusline host may well show.
  if (opts.statusline) return runStatusline(opts);

  // Same placement, same reason: --limits answers from the stdin payload, not
  // from a corpus scan, so none of the root/source diagnostics below apply. It
  // does read transcripts for the local half, but only after it has a window to
  // measure them against.
  if (opts.limits) return runLimits(opts);

  const wantClaude = opts.source === 'claude' || opts.source === 'all';
  const wantCodex = opts.source === 'codex' || opts.source === 'all';
  const haveClaudeRoot = wantClaude && fs.existsSync(opts.root);
  const haveCodexRoot = wantCodex && fs.existsSync(opts.codexRoot);

  if (!haveClaudeRoot && !haveCodexRoot) {
    const missing = [
      ...(wantClaude ? [`  --root       ${opts.root}`] : []),
      ...(wantCodex ? [`  --codex-root ${opts.codexRoot}`] : []),
    ];
    process.stderr.write(
      `contextbill: no transcripts at:\n${missing.join('\n')}\n` +
        'Point the flag at a directory of .jsonl transcripts.\n',
    );
    return 0;
  }

  // With --source all, one missing root is not a failure — it is one agent that
  // is not installed. Saying so beats reporting a total that silently covers
  // half of what was asked for.
  if (wantClaude && !haveClaudeRoot) {
    process.stderr.write(
      `contextbill: no Claude Code transcripts at ${opts.root} — reading Codex only.\n\n`,
    );
  }
  if (wantCodex && !haveCodexRoot) {
    process.stderr.write(
      `contextbill: no Codex rollouts at ${opts.codexRoot} — reading Claude Code only.\n\n`,
    );
  }

  const table = loadPriceTable();

  // Resolve --plan before the corpus is read. A typo that only surfaces after a
  // full scan reads as a failure of the tool rather than of the flag, and the
  // scan is the slow part.
  let planTable: PlanTable | null = null;
  if (opts.plan !== '') {
    const plans = table.plans;
    if (plans === undefined || Object.keys(plans.entries).length === 0) {
      process.stderr.write(
        'contextbill: this price table carries no plan prices, so --plan cannot be answered.\n' +
          'Plan prices live under "plans" in prices.json.\n',
      );
      return 0;
    }
    if (!Object.prototype.hasOwnProperty.call(plans.entries, opts.plan)) {
      process.stderr.write(
        `contextbill: unknown plan "${opts.plan}".\n` +
          `Supported: ${Object.keys(plans.entries).join(', ')}\n` +
          'A plan appears there only when its current price can be cited. One that ' +
          'exists and is missing is one contextbill will not guess the price of.\n',
      );
      return 0;
    }
    planTable = plans;
  }

  const scanned: SessionStat[] = [];
  const unreadable: UnreadableFile[] = [];
  let singleProject = false;

  if (haveClaudeRoot) {
    const claude = scanCorpus(opts.root);
    scanned.push(...claude.stats);
    unreadable.push(...claude.unreadable);
    singleProject = claude.layout.singleProject;
  }
  if (haveCodexRoot) {
    // No layout to infer: Codex files by date, and the project comes from inside
    // each rollout rather than from the directory it sits in.
    const codex = scanCodexCorpus(opts.codexRoot);
    scanned.push(...codex.stats);
    unreadable.push(...codex.unreadable);
  }

  // Pointing --root at one project directory used to be indistinguishable from
  // pointing it at the projects root: it produced a smaller, plausible number with
  // no indication that it covered one slug. The scan is correct either way now,
  // but the user still has to be told which one they measured.
  if (singleProject) {
    process.stderr.write(
      `contextbill: ${opts.root}\n` +
        '  looks like one project directory rather than a transcripts root.\n' +
        '  Scanning it as a single project. For everything, use\n' +
        '  --root ~/.claude/projects\n\n',
    );
  }

  // Say what could not be read before reporting any total built without it. A
  // total that silently excludes files looks complete and is not.
  if (unreadable.length > 0) {
    const shown = unreadable.slice(0, 5).map((u) => `    ${u.path} - ${u.reason}`);
    const more = unreadable.length > 5 ? `    and ${unreadable.length - 5} more\n` : '';
    process.stderr.write(
      `contextbill: ${unreadable.length} transcript(s) could not be read and are ` +
        `excluded from the totals below.\n${shown.join('\n')}\n${more}\n`,
    );
  }

  // Filter on the raw slug, before redaction. Redaction strips exactly the part
  // of the path a user would type to identify their own project, so matching
  // afterwards would fail on the obvious query and look like a missing project.
  const selected =
    opts.project === ''
      ? scanned
      : scanned.filter((s) => s.project.toLowerCase().includes(opts.project.toLowerCase()));

  if (opts.project !== '' && selected.length === 0) {
    const available = [...new Set(scanned.map((s) => s.project))].sort();
    process.stderr.write(
      `contextbill: no project matching "${opts.project}" under ${opts.root}\n` +
        (available.length > 0
          ? `Projects found: ${available.slice(0, 12).join(', ')}` +
            (available.length > 12 ? `, and ${available.length - 12} more` : '') +
            '\n'
          : ''),
    );
    return 0;
  }

  // Project slugs encode the OS username and directory tree. The report exists
  // to be shared, so redaction is the default and showing them is opt-in.
  const stats = opts.showPaths
    ? selected
    : selected.map((s) => ({ ...s, project: redactProject(s.project, home) }));

  if (stats.length === 0) {
    process.stderr.write(`contextbill: found no .jsonl transcripts under ${opts.root}\n`);
    return 0;
  }

  const base = aggregate(stats, {
    table,
    ttl: opts.ttl,
    cacheWriteMult: cacheWriteMultiplier(table, opts.ttl),
    topN: opts.top,
  });

  // Attached only when a source other than the default was asked for. A plain
  // Claude Code run keeps byte-identical --json output, and a one-row breakdown
  // of a single-agent corpus would say nothing the totals do not.
  const withSource: Report =
    opts.source === 'claude' ? base : { ...base, bySource: summariseSources(stats, table, opts.ttl) };

  const report: Report =
    planTable === null
      ? withSource
      : { ...withSource, plan: planUtilization(withSource, planTable, opts.plan) };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  // Transcripts were present but nothing billable parsed out of them. Printing
  // "$0.00" here would read as a real answer when it is a parse failure — the
  // exact confident-wrong-number this tool exists to prevent.
  if (report.turns === 0) {
    const roots = [
      ...(haveClaudeRoot ? [opts.root] : []),
      ...(haveCodexRoot ? [opts.codexRoot] : []),
    ].join(' and ');
    const expected =
      opts.source === 'codex'
        ? 'a Codex rollout root'
        : opts.source === 'all'
          ? 'a Claude Code transcript root or a Codex rollout root'
          : 'a Claude Code transcript root';
    process.stderr.write(
      `contextbill: read ${stats.length} transcript file(s) under ${roots}, ` +
        'but found no usage data in any of them.\n' +
        `That usually means this is not ${expected}, or the ` +
        'files are in a format this version does not understand.\n' +
        'No report written.\n',
    );
    return 0;
  }

  writeAtomic(opts.out, renderReport(report));

  const f = report.findings;
  const lines = [
    '',
    `  ${usd(report.cost.total)} at API rates across ${report.turns.toLocaleString('en-US')} turns in ${report.sessionCount.toLocaleString('en-US')} sessions`,
    `  ${usd(monthlyProjection(report))} projected per 30 days`,
    `  ${f.medianStartupPrefix.toLocaleString('en-US')} median tokens loaded before you type — ${usd(f.startupPrefixUsd)} of that total`,
    '',
  ];
  // The per-source split goes above everything else, because it qualifies the
  // headline itself rather than adding to it. When a Codex row is present its
  // dollar column is blank by design — the tokens are measured, the rates do not
  // exist in this repo, and a reader has to see which half of the total above
  // the dollar figure actually covers.
  const bySource = report.bySource;
  if (bySource !== undefined && bySource.length > 0) {
    const width = Math.max(...bySource.map((s) => s.label.length));
    lines.push('  by source:');
    for (const row of bySource) {
      const money = row.fullyPriced
        ? usd(row.usd)
        : row.usd > 0
          ? `${usd(row.usd)} (partly unpriced)`
          : 'no rates in prices.json';
      lines.push(
        `    ${row.label.padEnd(width)}  ${row.turns.toLocaleString('en-US')} turns · ` +
          `${totalTokens(row.usage).toLocaleString('en-US')} tokens · ${money}`,
      );
    }
    const blind = bySource.filter((s) => !s.fullyPriced);
    if (blind.length > 0) {
      const models = [...new Set(blind.flatMap((s) => s.unpricedModels))].sort();
      // The ids go on their own line: with three or four of them the sentence
      // otherwise runs past the width every other line in this block keeps.
      lines.push(
        '',
        `  ${models.join(', ')}`,
        '  carry no rate in prices.json, so their tokens are counted above and left out',
        '  of every dollar figure. contextbill does not guess a rate: a wrong one prices',
        '  real usage confidently and nothing fails.',
      );
    }
    lines.push('');
  }

  // The plan block sits directly under the headline because that is where a
  // reader stops. Every branch of it names its own limit inline: a multiple is
  // printed only when whole months produced it, and the sentence that says
  // these are not billed dollars is never further away than the next line.
  const plan = report.plan;
  if (plan !== undefined) {
    if (plan.billing === 'metered') {
      // No fee, so nothing here depends on the plan-price date — saying when a
      // price was read would imply a price was used.
      lines.push(
        `  ${plan.label}: metered, no flat fee — the total above is an estimate of what`,
        '  those tokens are worth at API rates, not a break-even multiple',
        '',
      );
    } else if (plan.ratio === null || plan.completePlanUsd === null) {
      lines.push(
        `  ${plan.label}: ${usd(plan.usdPerMonth ?? 0)}/month${plan.perSeat ? ' per seat' : ''}`,
        '  no whole calendar month in this corpus, so no break-even multiple is reported —',
        '  a partial month against a full fee understates it. Per-month rows are in the report.',
      );
    } else {
      lines.push(
        `  ${plan.label}: ${usd(plan.usdPerMonth ?? 0)}/month${plan.perSeat ? ' per seat' : ''}`,
        `  ${usd(plan.completeUsd)} of API-equivalent value over ${plan.completeMonths} whole month(s)`,
        `  against ${usd(plan.completePlanUsd)} in fees — ${plan.ratio.toFixed(2)}x break-even`,
      );
      const partial = plan.months.filter((m) => !m.complete).length;
      if (partial > 0) {
        lines.push(
          `  ${partial} partial month(s) excluded from that multiple, shown in the report`,
        );
      }
      // The multiple divides API-equivalent value by fees, so anything still
      // double-counted in the value pushes it UP — the single direction this
      // feature promises it never errs in. That is why `planUtilization` charges
      // every idle month inside the span and refuses a multiple over a partial
      // one; both of those biases are corrected at the source in aggregate.ts,
      // so nothing about them is repeated here.
      //
      // The cross-file residual is NOT corrected there and cannot be: the copies
      // whose line ids never matched stay inside `cost.total`, therefore inside
      // every `byMonth` row, therefore inside the numerator above. It is
      // measured, so it is stated as a figure rather than hedged about — and it
      // is printed only when it is non-zero, because a caveat that is always
      // there teaches a reader to discount a number that needs no discount.
      if (report.deduplication.duplicatedUsd > 0) {
        lines.push(
          `  ${usd(report.deduplication.duplicatedUsd)} of this corpus is still counted twice and sits inside`,
          '  that value — read the multiple as a ceiling, not a floor',
        );
      }
    }
    if (plan.billing !== 'metered') {
      lines.push(`  plan prices dated ${plan.priceDated} — a vendor fact, not a measurement`, '');
    }
  }
  if (f.noFileWritten.length > 0) {
    lines.push(`  ${f.noFileWritten.length} long session(s) wrote no file — see the report`);
  }
  if (f.deadRuns.length > 0) {
    lines.push(`  ${f.deadRuns.length} run(s) look like they died on startup`);
  }
  if (report.unpricedModelsSeen.length > 0) {
    lines.push(`  unpriced models excluded: ${report.unpricedModelsSeen.join(', ')}`);
  }
  // Stated on the terminal, not just in the HTML: a reader comparing this run
  // against an older one needs to know the difference is a fixed double-count.
  const dedup = report.deduplication;
  const count = (n: number): string => n.toLocaleString('en-US');
  if (dedup.rewritesCollapsed > 0) {
    lines.push(
      `  ${count(dedup.rewritesCollapsed)} streamed rewrite(s) collapsed — usage is counted once per message`,
    );
  }
  // The same rule as the line above, applied to the correction that is an order
  // of magnitude larger. The cross-file merge moves the HEADLINE — it took
  // $1,145.70 off the corpus it was built against, 7.40% of the run — so a user
  // comparing this against last week's output sees a large drop with nothing on
  // screen to attribute it to. The HTML report has always disclosed it; the
  // terminal is the surface most people actually read.
  if (dedup.crossFileMessagesMerged > 0) {
    lines.push(
      `  ${count(dedup.crossFileMessagesMerged)} message(s) copied forward by a resumed session merged across ` +
        `${count(dedup.crossFileTranscriptsCorrected)} transcript(s) —`,
      `  ${usd(dedup.crossFileUsdMerged)} that would otherwise be counted twice`,
    );
  }
  // NOT "(resumed sessions)". That label inverted the moment the merge above
  // started running: a PROVABLE resume — same message id, same line id — is
  // exactly what it removes, and what survives to here is the set where the ids
  // matched and no line id did. Those are one message's streamed rewrites split
  // across sibling subagent files, or a gateway handing one id to two
  // independent sessions; neither is a resumed session. report.ts was corrected
  // for this and this line was not, so the two surfaces said opposite things
  // about the same number.
  if (dedup.sharedMessageIds > 0) {
    lines.push(
      `  ${count(dedup.sharedMessageIds)} message id(s) span ${count(dedup.transcriptsSharingHistory)} transcripts with no shared line id —`,
      `  nothing proves they are the same request, so they are NOT merged` +
        ` (about ${usd(dedup.duplicatedUsd)} counted twice)`,
    );
  }
  // The basis belongs next to the number, not in a footnote. Read without it,
  // a subscription user takes the total for what they were charged.
  lines.push(
    '',
    '  Figures are API-equivalent — what this usage would cost metered at the',
    `  published ${pricedProviders(report, opts.source)} API rates. A subscription bills a flat fee instead.`,
  );
  lines.push('', `  report -> ${opts.out}`, '');

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * Only run when invoked as the binary, never on import.
 *
 * Without this guard, importing anything from this module executes the whole
 * CLI and then calls process.exit — which makes `parseArgs` untestable and
 * would surprise any consumer that imported it.
 *
 * Both sides are resolved to a real path before they are compared. `argv[1]` is
 * whatever the shell handed us, and for an installed package that is npm's bin
 * entry — a symlink to this file on POSIX, a shim on Windows — while
 * `import.meta.url` is always the fully resolved module. Comparing the two
 * unresolved made `npx contextbill` a silent no-op: the guard was false, main
 * never ran, and nothing was printed to say so.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return canonicalPath(invoked) === canonicalPath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Absolute, symlink-free, comparable. `realpathSync.native` also normalises the
 * drive-letter case and expands 8.3 short names on Windows; it throws if the
 * path does not exist, so the resolved path stands in when it does.
 */
function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    real = resolved;
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

if (isEntryPoint()) {
  // Read straight off argv rather than from parseArgs, because parseArgs itself
  // has to be inside the try: this decides how a failure is *reported*, so it
  // cannot depend on anything that might be the thing that failed.
  const quiet = process.argv.slice(2).includes('--statusline');
  let code = 0;
  try {
    code = main();
  } catch (err) {
    if (quiet) {
      // A statusline's stdout and stderr land in someone's prompt. Nothing
      // useful can be said there, so say nothing and let the host drop the
      // line. This is the one path that does not honour the always-exit-0 rule.
      code = 1;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`contextbill failed (non-fatal): ${message}\n`);
      code = 0;
    }
  }
  process.exit(code);
}
