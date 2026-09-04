import { classify, isMutatingTool, mcpServer } from './classify.js';
import { zeroUsage } from './cost.js';
import type { ModelUsage, RawUsage, SessionStat, ToolCategory } from './types.js';

/**
 * Transcript parsing — pure, and deliberately free of Node built-ins.
 *
 * This module is imported by BOTH the CLI (which reads text off disk) and the
 * web app (which reads it from a File in the browser), so the two cannot
 * produce different numbers from the same transcript. Importing `node:fs` here
 * would break the browser bundle, which is why the filesystem walker lives in
 * `scan.ts` instead.
 *
 * The bookkeeping below looks fussier than it needs to be and each piece is
 * load-bearing:
 *
 *  - A `tool_result` block names only `tool_use_id`, never the tool. The tool
 *    name lives on the earlier `tool_use` block, so results can only be
 *    attributed by carrying a pending id -> name map across lines.
 *  - Malformed lines are skipped, not thrown on. Transcripts are appended to by
 *    a live process and the final line is routinely a partial write.
 *  - The startup prefix is read from the FIRST turn only. On later turns the
 *    same tokens reappear as cache reads and would be counted repeatedly.
 *  - Every usage row carries the UTC day its turns happened on, and a session
 *    that runs past midnight produces one row per day per model. A row is an
 *    aggregate, so a single timestamp on a row spanning a price change would
 *    bill both sides of the change at one rate; cutting on the day is finer
 *    than any boundary a `YYYY-MM-DD` rate period can express, so no row can
 *    span one. See `rateInForce` in cost.ts.
 *  - Usage is deduplicated by `message.id`. A streamed assistant message is
 *    written to the transcript several times as it grows, and every one of
 *    those lines repeats that message's CUMULATIVE usage. Summing them is not
 *    an approximation, it is a multiplication. Measured 2026-09-03 over 1,884
 *    real transcripts and 413,702 lines: 150,662 usage-bearing lines collapse
 *    to 65,474 messages, inflating input 3.44x, cache writes 2.83x, cache reads
 *    2.23x and output 2.16x, and the priced total 2.43x.
 */

interface TranscriptUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  speed?: string;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface TranscriptLine {
  timestamp?: string;
  message?: {
    id?: unknown;
    model?: string;
    usage?: TranscriptUsage;
    content?: ContentBlock[] | string;
  };
}

/**
 * One assistant message's usage, after its rewrites have been collapsed.
 *
 * Held by reference in both `records` and the id map so a later rewrite raises
 * the same object the totals are eventually summed from.
 */
interface UsageRecord {
  usage: RawUsage;
  /** Null when the line carried no model; such a record still counts as a turn. */
  model: string | null;
  speed: 'standard' | 'fast';
  /**
   * When the message was written, epoch ms, or null when none of its lines
   * carried a parseable timestamp. This is what dates the priced row. An
   * undated record stays undated rather than borrowing a neighbouring line's
   * clock: file order is not evidence of when a turn ran, and an undated row is
   * already priced at the current rate by documented default.
   */
  at: number | null;
}

/**
 * `YYYY-MM-DD` in UTC, or the empty string for an undated record.
 *
 * Built by hand rather than through `toISOString`, which throws on an instant it
 * cannot represent. This value is only ever compared for equality, so a strange
 * timestamp has to produce a stable string rather than an exception.
 */
function utcDayKey(at: number | null): string {
  if (at === null) return '';
  const d = new Date(at);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${String(d.getUTCFullYear())}-${mm}-${dd}`;
}

// U+0000 as the separator: it cannot occur inside a model id, so the composite
// key is unambiguous. Declared as an escape rather than written as a literal
// byte, which would make this file read as binary to grep and diff tools.
const KEY_SEP = '\u0000';

/**
 * The bucket a record's usage is summed into.
 *
 * The UTC day is part of the key so that a row never spans a rate change. Rate
 * periods start on a `YYYY-MM-DD` boundary in UTC, so a row confined to one day
 * sits wholly inside exactly one period whatever the table says. Without the
 * day, a session running past midnight on the day a price moved would carry one
 * timestamp for turns billed at two different rates, and nothing would fail.
 */
function usageKey(model: string, speed: string, day: string): string {
  return `${model}${KEY_SEP}${speed}${KEY_SEP}${day}`;
}

export interface ParseOptions {
  /** Session identifier — the transcript's basename. */
  id: string;
  /** Project label. Already redacted, or redacted by the caller. */
  project: string;
  /** Subagent transcripts nest deeper than `<project>/<id>.jsonl`. */
  isSubagent: boolean;
  /** Size of the transcript in bytes; the dead-run signal. */
  bytes: number;
  /** Opaque origin, carried through onto the stat. Empty in the browser. */
  file?: string;
}

export function parseTranscript(text: string, opts: ParseOptions): SessionStat {
  const stat: SessionStat = {
    file: opts.file ?? '',
    project: opts.project,
    id: opts.id,
    turns: 0,
    usage: zeroUsage(),
    byModel: [],
    startupPrefix: 0,
    isSubagent: opts.isSubagent,
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
    messageIds: [],
  };

  const pending: Record<string, string> = Object.create(null) as Record<string, string>;
  const models = new Map<string, ModelUsage>();

  // One entry per billed message, in first-appearance order. `byId` indexes the
  // same objects so a rewrite raises the record it restates. The map is local to
  // this call, which is what scopes deduplication to a single transcript.
  const records: UsageRecord[] = [];
  const byId = new Map<string, UsageRecord>();

  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }

    let lineAt: number | null = null;
    if (parsed.timestamp) {
      const ts = Date.parse(parsed.timestamp);
      if (!Number.isNaN(ts)) {
        lineAt = ts;
        if (stat.startedAt === null) stat.startedAt = ts;
        stat.endedAt = ts;
      }
    }

    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          pending[block.id] = block.name;
          const server = mcpServer(block.name);
          if (server !== null) {
            stat.connectorCalls[server] = (stat.connectorCalls[server] ?? 0) + 1;
          }
          if (isMutatingTool(block.name)) {
            stat.producedFile = true;
            stat.fileWrites += 1;
          }
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const name = pending[block.tool_use_id] ?? 'unknown';
          const size =
            typeof block.content === 'string'
              ? block.content.length
              : JSON.stringify(block.content ?? '').length;
          const category: ToolCategory = classify(name);
          stat.toolBytes[category] = (stat.toolBytes[category] ?? 0) + size;
          // Tracked alongside the category rather than instead of it: a browser
          // tool is an MCP tool, so it belongs to a server here and to `browser`
          // there. The two tables cut the same spend along different lines.
          const resultServer = mcpServer(name);
          if (resultServer !== null) {
            stat.connectorBytes[resultServer] = (stat.connectorBytes[resultServer] ?? 0) + size;
          }
        }
      }
    }

    const u = parsed.message?.usage;
    if (!u) continue;

    const turn: RawUsage = {
      input: u.input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };

    const rawId = parsed.message?.id;
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : null;
    const model = parsed.message?.model ?? null;
    const speed: 'standard' | 'fast' = u.speed === 'fast' ? 'fast' : 'standard';

    if (id === null) {
      // Nothing to deduplicate against, so it is its own record. Keeping it is
      // the safe direction: dropping it loses spend that was really billed,
      // while keeping a rewrite that lost its id overstates by one message.
      stat.unidentifiedUsage += 1;
      records.push({ usage: turn, model, speed, at: lineAt });
      continue;
    }

    const seen = byId.get(id);
    if (seen === undefined) {
      const record: UsageRecord = { usage: turn, model, speed, at: lineAt };
      byId.set(id, record);
      records.push(record);
      stat.messageIds.push(id);
      continue;
    }

    // A rewrite of a message already recorded. Each rewrite restates that
    // message's running totals, so the billed figure is the MAXIMUM per field:
    // not the sum, which multiplies; not the last line, because the rewrites
    // are cumulative while their arrival order is not guaranteed; and not the
    // first, which is usually a partial write.
    seen.usage.input = Math.max(seen.usage.input, turn.input);
    seen.usage.cacheWrite = Math.max(seen.usage.cacheWrite, turn.cacheWrite);
    seen.usage.cacheRead = Math.max(seen.usage.cacheRead, turn.cacheRead);
    seen.usage.output = Math.max(seen.usage.output, turn.output);
    // A rewrite can carry fields the first line of the same message did not.
    if (seen.model === null) seen.model = model;
    if (speed === 'fast') seen.speed = 'fast';
    // The message is dated by its EARLIEST line. A rewrite is the same message
    // still being written, so a later rewrite must not push the message's date
    // forward — on the one night a year it matters, that would move a turn onto
    // the wrong side of a rate change.
    if (lineAt !== null && (seen.at === null || lineAt < seen.at)) seen.at = lineAt;
    stat.usageRewrites += 1;
  }

  // Totals are summed from the collapsed records rather than accumulated line
  // by line, so every consumer of `usage`, `byModel` and `turns` sees one entry
  // per billed message. `turns` in particular feeds the startup-prefix re-read
  // count in aggregate.ts, where a rewrite is not a re-read.
  for (const record of records) {
    stat.usage.input += record.usage.input;
    stat.usage.cacheWrite += record.usage.cacheWrite;
    stat.usage.cacheRead += record.usage.cacheRead;
    stat.usage.output += record.usage.output;

    if (record.model === null) continue;
    const key = usageKey(record.model, record.speed, utcDayKey(record.at));
    let entry = models.get(key);
    if (!entry) {
      entry = {
        model: record.model,
        speed: record.speed,
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
    // one a reader can check against the transcript's own first line.
    if (record.at !== null && (entry.at == null || record.at < entry.at)) entry.at = record.at;
  }

  stat.turns = records.length;

  // The fixed cost paid before the user typed anything, from the FIRST message
  // only — on later turns these same tokens return as cache reads. Taken from
  // the collapsed record, because the first LINE of that message is typically a
  // partial rewrite and reading it understates the prefix.
  const first = records[0];
  if (first !== undefined && !stat.isSubagent) {
    stat.startupPrefix = first.usage.cacheRead + first.usage.cacheWrite + first.usage.input;
  }

  stat.byModel = [...models.values()];
  return stat;
}
