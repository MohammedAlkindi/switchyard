/**
 * All shared interfaces. Per house standard these are defined here before any
 * module that consumes them.
 */

/** The four token classes the Messages API bills separately. */
export interface RawUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Buckets a tool call's returned bytes are attributed to. */
export type ToolCategory =
  | 'browser'
  | 'files'
  | 'shell'
  | 'web'
  | 'subagents'
  | 'connectors'
  | 'other';

/** Cache-write TTL. Transcripts do not record this, so it is a user-supplied assumption. */
export type CacheTtl = '5m' | '1h';

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million input tokens when `usage.speed === 'fast'`. */
  fastInput?: number;
  /** USD per million output tokens when `usage.speed === 'fast'`. */
  fastOutput?: number;
  note?: string;
}

export interface PriceTable {
  dated: string;
  currency: string;
  source: string;
  cacheWriteMultiplier: Record<string, number | string>;
  cacheReadMultiplier: number;
  models: Record<string, ModelPrice>;
  unpricedModels: { ids: string[] };
}

/**
 * Usage for one model within one session, split by speed so fast-mode turns
 * can be priced at their own rate.
 */
export interface ModelUsage {
  model: string;
  speed: 'standard' | 'fast';
  usage: RawUsage;
  turns: number;
}

/** Everything one transcript file yields. Kept small: one of these per transcript. */
export interface SessionStat {
  /** Absolute path. Identifies the transcript; never emitted into a report. */
  file: string;
  /** Project directory slug the transcript sits under. */
  project: string;
  /** Session id (transcript basename). */
  id: string;
  turns: number;
  usage: RawUsage;
  byModel: ModelUsage[];
  /**
   * Tokens loaded on the very first turn, before the user typed anything:
   * system prompt + tool catalog + CLAUDE.md + connectors. Zero for subagents.
   */
  startupPrefix: number;
  /** Subagent transcripts nest deeper than <project>/<id>.jsonl. */
  isSubagent: boolean;
  /** Bytes returned into context per tool category. */
  toolBytes: Partial<Record<ToolCategory, number>>;
  /** Bytes returned into context per MCP server. Keyed by the server segment. */
  connectorBytes: Record<string, number>;
  /** Tool calls made per MCP server. */
  connectorCalls: Record<string, number>;
  /** True if any Write / Edit / NotebookEdit call was made. */
  producedFile: boolean;
  /** Count of Write / Edit / NotebookEdit calls. */
  fileWrites: number;
  /** Epoch ms of the first and last timestamped entry, or null when absent. */
  startedAt: number | null;
  endedAt: number | null;
  /** Byte size of the transcript on disk — the health signal for dead runs. */
  bytes: number;
}

/** A priced line item. */
export interface CostBreakdown {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
}

export interface CategoryCost {
  category: string;
  usd: number;
  share: number;
}

/**
 * What one project directory cost.
 *
 * `startupPrefixUsd` here is the sum of the same per-session figures the corpus
 * total is built from, each already capped at that session's non-output spend.
 * Summing those is exact. Recomputing a prefix from project-level aggregates
 * would not be — the cap is a per-session property and does not survive being
 * applied to a pooled total.
 */
export interface ProjectCost {
  project: string;
  usd: number;
  share: number;
  turns: number;
  sessions: number;
  transcripts: number;
  startupPrefixUsd: number;
}

/**
 * What one MCP server cost, and how much it was used.
 *
 * Derived from calls that happened. A transcript carries no tool catalog, so a
 * connector that was loaded and never called leaves no trace here at all — it
 * is paid for in the startup prefix and is invisible to this table. The report
 * states that limit next to the table rather than letting the list read as
 * complete.
 */
export interface ConnectorCost {
  server: string;
  usd: number;
  share: number;
  calls: number;
  bytes: number;
}

export interface SessionCost {
  id: string;
  project: string;
  turns: number;
  usd: number;
  usdPerTurn: number;
  producedFile: boolean;
  startupPrefix: number;
  startedAt: number | null;
  bytes: number;
}

export interface TurnBucket {
  label: string;
  usd: number;
  share: number;
  sessions: number;
}

/** A transcript that started but produced essentially nothing. */
export interface DeadRun {
  id: string;
  project: string;
  turns: number;
  bytes: number;
  startedAt: number | null;
}

export interface Findings {
  /** Sessions that ran long but never wrote a file. */
  noFileWritten: SessionCost[];
  /** Cost concentration by session length. */
  turnBuckets: TurnBucket[];
  /** Transcripts that look like they died on startup. */
  deadRuns: DeadRun[];
  /** Median startup prefix across main sessions. */
  medianStartupPrefix: number;
  /** Total USD paid for startup prefix re-reads across all sessions. */
  startupPrefixUsd: number;
}

export interface Report {
  generatedAt: string;
  priceTableDate: string;
  cacheTtlAssumed: CacheTtl;
  transcriptCount: number;
  sessionCount: number;
  turns: number;
  usage: RawUsage;
  cost: CostBreakdown;
  byModel: Array<{ model: string; usd: number; share: number; turns: number }>;
  byCategory: CategoryCost[];
  byProject: ProjectCost[];
  byConnector: ConnectorCost[];
  topSessions: SessionCost[];
  findings: Findings;
  unpricedModelsSeen: string[];
  /** Days spanned by the transcript corpus, for the monthly projection. */
  spanDays: number;
}
