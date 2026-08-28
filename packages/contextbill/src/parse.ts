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
    model?: string;
    usage?: TranscriptUsage;
    content?: ContentBlock[] | string;
  };
}

// U+0000 as the separator: it cannot occur inside a model id, so the composite
// key is unambiguous. Declared as an escape rather than written as a literal
// byte, which would make this file read as binary to grep and diff tools.
const KEY_SEP = '\u0000';

function usageKey(model: string, speed: string): string {
  return `${model}${KEY_SEP}${speed}`;
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
  };

  const pending: Record<string, string> = Object.create(null) as Record<string, string>;
  const models = new Map<string, ModelUsage>();
  let firstTurn = true;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }

    if (parsed.timestamp) {
      const ts = Date.parse(parsed.timestamp);
      if (!Number.isNaN(ts)) {
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

    stat.usage.input += turn.input;
    stat.usage.cacheWrite += turn.cacheWrite;
    stat.usage.cacheRead += turn.cacheRead;
    stat.usage.output += turn.output;
    stat.turns += 1;

    const model = parsed.message?.model;
    if (model) {
      const speed = u.speed === 'fast' ? 'fast' : 'standard';
      const key = usageKey(model, speed);
      let entry = models.get(key);
      if (!entry) {
        entry = { model, speed, usage: zeroUsage(), turns: 0 };
        models.set(key, entry);
      }
      entry.usage.input += turn.input;
      entry.usage.cacheWrite += turn.cacheWrite;
      entry.usage.cacheRead += turn.cacheRead;
      entry.usage.output += turn.output;
      entry.turns += 1;
    }

    // The fixed cost paid before the user typed anything. First turn only —
    // on later turns these same tokens return as cache reads.
    if (firstTurn && !stat.isSubagent) {
      stat.startupPrefix = turn.cacheRead + turn.cacheWrite + turn.input;
      firstTurn = false;
    }
  }

  stat.byModel = [...models.values()];
  return stat;
}
