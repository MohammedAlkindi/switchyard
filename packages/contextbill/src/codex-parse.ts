import { mcpServer } from './classify.js';
import { zeroUsage } from './cost.js';
import { projectSlugFromPath } from './privacy.js';
import type { ModelUsage, RawUsage, SessionStat, ToolCategory } from './types.js';

/**
 * OpenAI Codex CLI rollout parsing — pure, and deliberately free of Node
 * built-ins for the same reason `parse.ts` is: the browser reader has to be able
 * to run the identical code, or the CLI and the dashboard drift into disagreeing
 * about the same file with no test able to catch it. `scan.ts` owns `node:fs`.
 *
 * A rollout lives at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`
 * and every line is `{ timestamp, type, payload }`. Three line types carry
 * everything this reads:
 *
 *   session_meta  payload { session_id, cwd, cli_version, model_provider, ... }
 *   turn_context  payload { model, cwd, ... }        — the model in force
 *   event_msg     payload.type "token_count"          — the usage counter
 *
 * ---------------------------------------------------------------------------
 * THE COUNTER IS CUMULATIVE, AND THAT IS THE WHOLE PROBLEM
 * ---------------------------------------------------------------------------
 *
 * `payload.info.total_token_usage` is a RUNNING TOTAL for the session, restated
 * in full on every `token_count` event. `payload.info.last_token_usage` is the
 * most recent turn alone. Summing the cumulative field is not an approximation,
 * it is a multiplication — the same shape as the streamed-rewrite bug `parse.ts`
 * documents, wearing a different hat.
 *
 * Measured 2026-09-02 over the five rollouts on this machine (221 to 2,410
 * lines, 20 to 469 `token_count` events each), all three candidate readings:
 *
 *   sum of total_token_usage   catastrophic — on the largest file it reports
 *                              ~13.9 billion tokens against a true 59,901,944
 *   sum of last_token_usage    wrong on 3 of the 5 files. The counter is
 *                              restated verbatim when nothing advanced (1, 1, 0,
 *                              9 and 0 exact duplicates per file), so the naive
 *                              sum overstated by 4.1%, 0.1% and 1.6%
 *   monotonic-gated delta      exact on all 5, on input, cached input, output
 *                              and total independently
 *
 * So the rule here is: **accept a `token_count` event only when its cumulative
 * total STRICTLY ADVANCES, and take the turn's usage as the delta of the
 * cumulative counter.** Three properties follow, and each was measured rather
 * than assumed:
 *
 *  1. A session's total is `max(total_token_usage)` by construction. The counter
 *     is the sum of its own turns, so gating on it cannot lose spend however the
 *     events are ordered or duplicated.
 *  2. Exact duplicates vanish. They are counted in `usageRewrites`, which is the
 *     same field and the same meaning the Claude reader uses for a restatement
 *     of a message already recorded.
 *  3. Malformed per-turn records vanish with them. Four `last_token_usage`
 *     records in the corpus read `input_tokens: 0, output_tokens: 0` with a
 *     non-zero `total_tokens`; every one of them sat on an event whose
 *     cumulative had not advanced, so the gate drops all four for free. Reading
 *     `last_token_usage` directly would have taken them at face value.
 *
 * A cumulative that goes BACKWARDS is skipped. What that assumes is worth
 * stating plainly, because the obvious justification for it is wrong.
 *
 * A backwards counter is one of two things and the record cannot tell them
 * apart: an out-of-order restatement of a value already accepted, where skipping
 * genuinely loses nothing; or a real counter RESET, where skipping discards
 * every token spent from the reset until the counter climbs back past its old
 * high-water mark — which on a session that never gets that far is all of it.
 * There is no sequence number, no restart marker, and nothing in the payload
 * that separates the two.
 *
 * It is skipped anyway, for three reasons and not for the first one alone:
 *
 *  1. It did not occur once in the corpus — 0 of 732 events, including across
 *     the four `compacted` records, so compaction does not reset the counter.
 *     Any rule for telling a reset from a reordering would therefore be
 *     invented rather than measured.
 *  2. The two mistakes are not symmetric. Reading a reordering as a reset
 *     re-bases the accepted counter to a low value, so the next legitimate
 *     event from the ORIGINAL sequence produces a delta covering the whole
 *     session again — it roughly doubles the bill. Reading a reset as a
 *     reordering understates it. This tool's standing bias is to understate;
 *     the cache-TTL default is the same choice.
 *  3. Skipping is what keeps property 1 above true: the session total stays
 *     `max(total_token_usage)` however the events arrive.
 *
 * So the honest statement is not "skipping loses nothing". It is: a reset would
 * be undercounted, that is the accepted cost of never overcounting, and
 * `codex.test.ts` pins both halves so this stays a decision rather than a
 * comment nobody re-reads.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TOKEN FIELDS MEAN, BY ARITHMETIC
 * ---------------------------------------------------------------------------
 *
 * Both were derived from the records rather than from a docs page, because
 * getting either backwards silently changes the bill:
 *
 *  - `total_tokens === input_tokens + output_tokens` on every well-formed
 *     record (732 events, 0 exceptions). It is NOT
 *     `input + output + reasoning`. So `reasoning_output_tokens` is a SUBSET of
 *     `output_tokens`, already inside it. Adding it would inflate output by
 *     roughly 8-50% depending on the session. It is read and discarded here
 *     rather than added.
 *  - `cached_input_tokens <= input_tokens` on every record (0 exceptions), so
 *     cached input is a SUBSET of input, not an extra bucket beside it.
 *
 * That gives a total-preserving mapping onto `RawUsage`, which is the invariant
 * this file is built around:
 *
 *     cacheRead  = cached_input_tokens
 *     cacheWrite = cache_write_input_tokens        (0 throughout the corpus)
 *     input      = input_tokens - cacheRead - cacheWrite
 *     output     = output_tokens                   (reasoning already inside it)
 *
 *     input + cacheRead + cacheWrite === input_tokens
 *     input + cacheRead + cacheWrite + output === total_tokens
 *
 * `cache_write_input_tokens` was 0 or absent on all 732 events, so whether it is
 * a subdivision of `input_tokens` or a separate bucket is not observable here.
 * It is subtracted, which is the reading that keeps the invariant above true by
 * construction; if it were separate, the effect on any real number is nil while
 * it stays zero, and the invariant is what a test can hold onto.
 *
 * ---------------------------------------------------------------------------
 * PRICING
 * ---------------------------------------------------------------------------
 *
 * Nothing here prices anything. `prices.json` carries Anthropic first-party
 * rates and no OpenAI ones, so every Codex model falls through `priceAll` into
 * `unpricedModelsSeen` — tokens counted, dollars absent, and the report already
 * says so above its total. Inventing a rate to close that gap would make the
 * product confidently wrong with nothing failing, which is the one outcome worse
 * than a blank column.
 */

/** Raw counter shape as it appears under `payload.info`. */
interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexTokenInfo {
  total_token_usage?: CodexTokenUsage | null;
  last_token_usage?: CodexTokenUsage | null;
  model_context_window?: number | null;
}

interface CodexInvocation {
  server?: string;
  tool?: string;
}

interface CodexThreadSettings {
  model?: string;
}

/**
 * The union of every payload shape read below.
 *
 * One interface rather than a discriminated union because the discriminant sits
 * in two places — `line.type` for `session_meta` / `turn_context`, and
 * `payload.type` for everything under `event_msg` / `response_item` — so a
 * single tag cannot narrow it. Every field is optional and every read is
 * type-guarded at the point of use.
 */
interface CodexPayload {
  type?: string;
  // session_meta
  session_id?: string;
  cwd?: string;
  // turn_context
  model?: string;
  // event_msg / thread_settings_applied
  thread_settings?: CodexThreadSettings | null;
  // event_msg / token_count
  info?: CodexTokenInfo | null;
  // response_item / function_call | custom_tool_call
  name?: string;
  call_id?: string;
  // response_item / *_output
  output?: unknown;
  // event_msg / mcp_tool_call_end
  invocation?: CodexInvocation | null;
  result?: unknown;
  // event_msg / web_search_end
  results?: unknown;
  // event_msg / patch_apply_end
  success?: boolean;
}

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: CodexPayload;
}

/** Normalized cumulative counter. Every field a non-negative finite number. */
interface Counter {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  total: number;
}

/** One accepted turn, after the cumulative gate. */
interface CodexRecord {
  usage: RawUsage;
  model: string | null;
  /**
   * When the accepting `token_count` event was written, epoch ms, or null when
   * the line carried no parseable timestamp. This dates the priced row; an
   * undated turn stays undated rather than borrowing a neighbouring line's
   * clock, and is priced at the current rate by documented default.
   */
  at: number | null;
}

/**
 * `YYYY-MM-DD` in UTC, or the empty string for an undated record.
 *
 * Duplicated from parse.ts rather than shared, for the same reason the tool
 * tables are: these two readers are deliberately independent, and a helper that
 * both import is a place where a change to one silently reaches the other.
 * Built by hand rather than through `toISOString`, which throws on an instant it
 * cannot represent.
 */
function utcDayKey(at: number | null): string {
  if (at === null) return '';
  const d = new Date(at);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${String(d.getUTCFullYear())}-${mm}-${dd}`;
}

// U+0000 as the separator: it cannot occur inside a model id or a date, so
// the composite key is unambiguous. Declared as an escape rather than written
// as a literal byte, exactly as parse.ts does and for the same reason — a
// literal NUL makes the whole file read as binary to grep and ripgrep, which
// silently drops it out of every code search.
const KEY_SEP = '\u0000';

/**
 * Codex tool name -> spend category.
 *
 * Deliberately its own table rather than a change to `classify.ts`: that file is
 * a verbatim port of the reference measurement script's Claude Code buckets, and
 * the differential check against it only means anything while it stays verbatim.
 * Codex names none of the same tools, so mixing the two sets would make the
 * check meaningless in both directions.
 *
 * Names observed in the corpus: `exec` (573), `wait` (82), `shell_command` (36),
 * `apply_patch` (7), `view_image` (6), `update_plan` (3). The rest are
 * near-neighbours from the same families, listed so a rename does not silently
 * dump a large bucket into `other`.
 */
const CODEX_SHELL = new Set(['exec', 'shell', 'shell_command', 'local_shell', 'wait', 'kill']);
const CODEX_FILES = new Set(['apply_patch', 'read_file', 'write_file', 'view_image']);
const CODEX_WEB = new Set(['web_search', 'web_fetch', 'browser_open']);

/** Which bucket a Codex tool call's returned bytes belong to. */
export function codexCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'connectors';
  if (CODEX_SHELL.has(name)) return 'shell';
  if (CODEX_FILES.has(name)) return 'files';
  if (CODEX_WEB.has(name)) return 'web';
  return 'other';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function counter(raw: CodexTokenUsage | null | undefined): Counter | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const rawTotal = num(raw.total_tokens);
  return {
    input,
    cached: Math.min(num(raw.cached_input_tokens), input),
    cacheWrite: num(raw.cache_write_input_tokens),
    output,
    // The gate compares totals, so a record that omits `total_tokens` still
    // needs one. `input + output` is what the field equals on every well-formed
    // record in the corpus, so deriving it changes nothing where it is present
    // and keeps the record usable where it is not.
    total: rawTotal > 0 ? rawTotal : input + output,
  };
}

/** Size in bytes a tool result added to context. */
function resultSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The bucket a record's usage is summed into.
 *
 * Keyed on the UTC day as well as the model so that a row never spans a rate
 * change: rate periods start on a `YYYY-MM-DD` boundary in UTC, so a row
 * confined to one day sits wholly inside one period whatever the table says.
 * The speed segment is fixed because Codex records no fast tier.
 */
function usageKey(model: string, day: string): string {
  return `${model}${KEY_SEP}standard${KEY_SEP}${day}`;
}

export interface CodexParseOptions {
  /** Session identifier used when the rollout carries no `session_id`. */
  id: string;
  /** Size of the rollout in bytes; the dead-run signal. */
  bytes: number;
  /** Opaque origin, carried through onto the stat. Empty in the browser. */
  file?: string;
}

/**
 * Parse one Codex rollout into the same `SessionStat` the Claude reader
 * produces.
 *
 * `project` comes out as the SLUG form of the session's `cwd`, unredacted —
 * exactly like the Claude reader's raw directory slug, and for the same reason:
 * the caller filters on the raw value and then redacts, so `--project acme`
 * still matches. A caller that renders it without `redactProject` publishes the
 * user's OS account name, which is why neither reader redacts for you.
 */
export function parseCodexRollout(text: string, opts: CodexParseOptions): SessionStat {
  const stat: SessionStat = {
    source: 'codex',
    file: opts.file ?? '',
    project: 'unknown',
    id: opts.id,
    turns: 0,
    usage: zeroUsage(),
    byModel: [],
    startupPrefix: 0,
    // Codex writes one rollout per session with no nesting, so there is no
    // subagent transcript to distinguish. Reporting one would invent a
    // distinction the format does not make.
    isSubagent: false,
    toolBytes: {},
    connectorBytes: {},
    connectorCalls: {},
    producedFile: false,
    fileWrites: 0,
    startedAt: null,
    endedAt: null,
    bytes: opts.bytes,
    usageRewrites: 0,
    unidentifiedUsage: 0,
    // A rollout carries no per-message id, so there is nothing to key
    // cross-transcript overlap on. Left empty rather than filled with a
    // synthetic id, which would make `deduplication.sharedMessageIds` report a
    // resumed-session overlap this format cannot actually evidence.
    messageIds: [],
  };

  const pending: Record<string, string> = Object.create(null) as Record<string, string>;
  const models = new Map<string, ModelUsage>();
  const records: CodexRecord[] = [];

  let currentModel: string | null = null;
  let projectSet = false;
  let idSet = false;
  // The last ACCEPTED cumulative counter. Starts at zero, so the first accepted
  // event's delta is the event itself.
  let accepted: Counter = { input: 0, cached: 0, cacheWrite: 0, output: 0, total: 0 };

  const addBytes = (category: ToolCategory, size: number): void => {
    stat.toolBytes[category] = (stat.toolBytes[category] ?? 0) + size;
  };

  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed: CodexLine;
    try {
      parsed = JSON.parse(line) as CodexLine;
    } catch {
      // A rollout is appended to by a live process, so the last line is
      // routinely a partial write. Skipping beats throwing, as in parse.ts.
      continue;
    }

    let lineAt: number | null = null;
    if (typeof parsed.timestamp === 'string') {
      const ts = Date.parse(parsed.timestamp);
      if (!Number.isNaN(ts)) {
        lineAt = ts;
        if (stat.startedAt === null) stat.startedAt = ts;
        stat.endedAt = ts;
      }
    }

    const payload = parsed.payload;
    if (payload === undefined || payload === null) continue;

    // `session_meta` repeats when a thread is resumed — up to 19 times in one
    // corpus file, every copy naming the same cwd and session id. The FIRST is
    // the session's own; taking the last would mean a resumed thread could
    // rename the session it is already halfway through.
    if (parsed.type === 'session_meta') {
      if (!projectSet && typeof payload.cwd === 'string' && payload.cwd !== '') {
        stat.project = projectSlugFromPath(payload.cwd);
        projectSet = true;
      }
      if (!idSet && typeof payload.session_id === 'string' && payload.session_id !== '') {
        stat.id = payload.session_id;
        idSet = true;
      }
      continue;
    }

    if (parsed.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model !== '') currentModel = payload.model;
      // Backstop for a rollout whose header is missing or truncated: the turn
      // context carries the same cwd.
      if (!projectSet && typeof payload.cwd === 'string' && payload.cwd !== '') {
        stat.project = projectSlugFromPath(payload.cwd);
        projectSet = true;
      }
      continue;
    }

    switch (payload.type) {
      case 'thread_settings_applied': {
        const model = payload.thread_settings?.model;
        if (typeof model === 'string' && model !== '') currentModel = model;
        continue;
      }

      case 'function_call':
      case 'custom_tool_call': {
        const { name, call_id: callId } = payload;
        if (typeof name !== 'string' || name === '') continue;
        if (typeof callId === 'string' && callId !== '') pending[callId] = name;
        const server = mcpServer(name);
        if (server !== null) {
          stat.connectorCalls[server] = (stat.connectorCalls[server] ?? 0) + 1;
        }
        continue;
      }

      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = payload.call_id;
        const name = (typeof callId === 'string' ? pending[callId] : undefined) ?? 'unknown';
        const size = resultSize(payload.output);
        addBytes(codexCategory(name), size);
        const server = mcpServer(name);
        if (server !== null) {
          stat.connectorBytes[server] = (stat.connectorBytes[server] ?? 0) + size;
        }
        continue;
      }

      case 'mcp_tool_call_end': {
        // An MCP call reaches the rollout ONLY as this event — it produces no
        // `function_call` line — so counting it here cannot double-count the
        // branch above. Verified on the corpus: `exec`+`wait`+`shell_command`+
        // `apply_patch`+`view_image`+`update_plan` = 707, which is exactly the
        // 127 `function_call` plus 580 `custom_tool_call` lines, leaving the 37
        // MCP calls entirely outside that set.
        const server = payload.invocation?.server;
        const size = resultSize(payload.result);
        addBytes('connectors', size);
        if (typeof server === 'string' && server !== '') {
          stat.connectorBytes[server] = (stat.connectorBytes[server] ?? 0) + size;
          stat.connectorCalls[server] = (stat.connectorCalls[server] ?? 0) + 1;
        }
        continue;
      }

      case 'web_search_end': {
        addBytes('web', resultSize(payload.results));
        continue;
      }

      case 'patch_apply_end': {
        // The file-write signal, and the only one taken. `apply_patch` also
        // appears as a tool call, but only 7 times against 137 of these: most
        // patches are applied through the shell and leave no tool call at all,
        // so this event is the superset. Counting both would double the writes
        // of whichever sessions used the tool form.
        if (payload.success !== false) {
          stat.producedFile = true;
          stat.fileWrites += 1;
        }
        continue;
      }

      case 'token_count':
        break;

      default:
        continue;
    }

    const info = payload.info;
    if (info === null || info === undefined) continue;
    const cumulative = counter(info.total_token_usage);
    if (cumulative === null) continue;

    // THE GATE. Anything that does not strictly advance the running counter is a
    // restatement of spend already recorded — an exact duplicate, or an
    // out-of-order line. Either way its tokens are inside the cumulative figure
    // that was already accepted, so skipping it cannot lose spend and counting
    // it would add the same tokens twice.
    if (cumulative.total <= accepted.total) {
      stat.usageRewrites += 1;
      continue;
    }

    // Deltas of the cumulative counter, not `last_token_usage`. The two agreed
    // on every well-formed record in the corpus, and the delta additionally
    // guarantees the session total equals the counter's own final value.
    const inputTokens = Math.max(0, cumulative.input - accepted.input);
    const cacheRead = Math.max(0, cumulative.cached - accepted.cached);
    const cacheWrite = Math.max(0, cumulative.cacheWrite - accepted.cacheWrite);
    const output = Math.max(0, cumulative.output - accepted.output);

    records.push({
      usage: {
        // Cached input is a subset of input, so the fresh half is what is left
        // after the cached and written halves come out. Clamped rather than
        // allowed negative: a malformed record must not subtract from a total.
        input: Math.max(0, inputTokens - cacheRead - cacheWrite),
        cacheWrite,
        cacheRead,
        output,
      },
      model: currentModel,
      at: lineAt,
    });

    accepted = cumulative;
  }

  for (const record of records) {
    stat.usage.input += record.usage.input;
    stat.usage.cacheWrite += record.usage.cacheWrite;
    stat.usage.cacheRead += record.usage.cacheRead;
    stat.usage.output += record.usage.output;

    if (record.model === null) continue;
    const key = usageKey(record.model, utcDayKey(record.at));
    let entry = models.get(key);
    if (!entry) {
      // Codex records no fast/standard tier, so every turn is standard. Marking
      // them otherwise would price them at a rate the transcript never claimed.
      entry = {
        model: record.model,
        speed: 'standard',
        usage: zeroUsage(),
        turns: 0,
        at: record.at,
      };
      models.set(key, entry);
    }
    entry.usage.input += record.usage.input;
    entry.usage.cacheWrite += record.usage.cacheWrite;
    entry.usage.cacheRead += record.usage.cacheRead;
    entry.usage.output += record.usage.output;
    entry.turns += 1;
    // Every record in this bucket shares a UTC day, so any of their timestamps
    // resolves to the same rate period. The earliest is kept because it is the
    // one a reader can check against the rollout's own first event.
    if (record.at !== null && (entry.at == null || record.at < entry.at)) entry.at = record.at;
  }

  stat.turns = records.length;

  // The fixed cost paid before the user typed anything: the whole input side of
  // the first turn — system prompt, tool catalog, AGENTS.md. Identical formula
  // to the Claude reader, and it comes to the first turn's `input_tokens`,
  // since the three input buckets sum back to it. On later turns those same
  // tokens return as cached input, so counting them again multiplies the figure.
  const first = records[0];
  if (first !== undefined) {
    stat.startupPrefix = first.usage.input + first.usage.cacheRead + first.usage.cacheWrite;
  }

  stat.byModel = [...models.values()];
  return stat;
}
