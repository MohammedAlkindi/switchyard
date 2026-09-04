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

/**
 * One dated rate period for a model.
 *
 * `from` is the first UTC day the rate applied, inclusive; the period runs until
 * the next period's `from`. A vendor price change is a new period, never an edit
 * to an existing one — editing one silently reprices history, which is the bug
 * this shape exists to prevent.
 *
 * A period is a claim about what a vendor charged on a date. It is only ever
 * added with a source behind it: an invented historical rate is worse than no
 * history at all, because it prices old usage confidently and wrongly.
 */
export interface RatePeriod {
  /** `YYYY-MM-DD`, UTC, inclusive. */
  from: string;
  /** USD per million input tokens during this period. */
  input: number;
  /** USD per million output tokens during this period. */
  output: number;
  /** USD per million input tokens when `usage.speed === 'fast'`. */
  fastInput?: number;
  /** USD per million output tokens when `usage.speed === 'fast'`. */
  fastOutput?: number;
  /** Where this rate came from, and when it changed. */
  note?: string;
}

export interface ModelPrice {
  /** USD per million input tokens. The rate in force now. */
  input: number;
  /** USD per million output tokens. The rate in force now. */
  output: number;
  /** USD per million input tokens when `usage.speed === 'fast'`. */
  fastInput?: number;
  /** USD per million output tokens when `usage.speed === 'fast'`. */
  fastOutput?: number;
  note?: string;
  /**
   * Dated rate periods, earliest first. Optional, and absent from every entry in
   * `prices.json` today — no rate change this repo can evidence has happened.
   *
   * When present, the LAST period must restate the flat `input`/`output` above:
   * those fields stay the current rate, so a consumer that knows nothing about
   * periods keeps pricing at today's rate rather than at a historical one.
   * `prices.test.ts` pins that agreement.
   */
  periods?: RatePeriod[];
}

/**
 * Usage that was priced at a rate not known to have been in force when it happened.
 *
 * Raised when a turn's timestamp predates every period in the table: there is
 * nothing earlier to apply, so the earliest known rate is used. That is an
 * assumption in exactly the sense the cache-TTL default is one, and it is
 * carried out of pricing as data so a report can name it in the footer rather
 * than folding it in silently.
 */
export interface PriceEraAssumption {
  /** Model id, normalized to its price-table key. */
  model: string;
  /** Usage buckets priced this way. */
  entries: number;
  /** Turns those buckets cover. */
  turns: number;
  /** Earliest turn timestamp seen, epoch ms. */
  earliestAt: number;
  /** `from` of the earliest known period — the rate that was applied instead. */
  appliedFrom: string;
}

/**
 * How a plan charges. `flat` is a subscription fee that does not move with
 * usage; `metered` is billed per token and therefore has no fee to divide by.
 *
 * The distinction is load-bearing rather than descriptive: a break-even
 * multiple only means anything against a flat fee, so `metered` is the signal
 * that suppresses the ratio entirely instead of printing a misleading 1.0.
 */
export type PlanBilling = 'flat' | 'metered';

/**
 * What one subscription plan costs.
 *
 * This is a vendor fact copied from a published page, not something contextbill
 * measures — see the `$comment-plans` block in `prices.json`. A plan whose
 * current price cannot be evidenced is left out of the table rather than
 * estimated, and `--plan` rejects an id that is not there.
 */
export interface PlanPrice {
  /** Plan name as the vendor prints it. */
  label: string;
  billing: PlanBilling;
  /**
   * USD per month when billed monthly. Absent for a metered plan.
   *
   * This is the figure the break-even multiple divides by, deliberately: where
   * a plan also offers annual billing this is the higher of the two prices, so
   * it produces the smaller multiple.
   */
  usdPerMonth?: number;
  /** USD per month when billed annually, where the vendor publishes one. */
  usdPerMonthAnnual?: number;
  /** True when the price is per seat rather than per account. */
  perSeat?: boolean;
  /** Where the figure came from, and anything that qualifies it. */
  note?: string;
}

/** The plan block of the price table: its own date, its own source. */
export interface PlanTable {
  dated: string;
  source: string;
  currency: string;
  entries: Record<string, PlanPrice>;
}

export interface PriceTable {
  dated: string;
  currency: string;
  source: string;
  cacheWriteMultiplier: Record<string, number | string>;
  cacheReadMultiplier: number;
  models: Record<string, ModelPrice>;
  unpricedModels: { ids: string[] };
  /**
   * Subscription plan prices. Optional so a hand-made or older table still
   * type-checks; `--plan` fails with a readable message when it is absent
   * rather than pricing against nothing.
   */
  plans?: PlanTable;
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
  /**
   * When these turns happened, epoch ms — the timestamp their rate is looked up
   * against, so a turn is priced at the rate in force when it ran rather than at
   * today's.
   *
   * Both readers set this, and both keep a row inside ONE UTC day so that it
   * cannot span a rate-period boundary — a row is an aggregate, and a single
   * timestamp on a row straddling a price change would bill both sides at one
   * rate. Rate periods start on a `YYYY-MM-DD` boundary in UTC, so a day is
   * always finer than a period.
   *
   * Null when the transcript lines behind the row carried no parseable
   * timestamp. Such a row is priced at the CURRENT rate, which is what this tool
   * did before periods existed; a neighbouring line's clock is not evidence of
   * when a turn ran. Optional so a caller constructing a row by hand need not
   * supply one, which reads the same as null.
   */
  at?: number | null;
}

/**
 * A transcript that was found but could not be turned into numbers.
 *
 * Defined here rather than in either reader because both produce it: the CLI
 * reads through `node:fs`, the web app through a picked `File`, and a file
 * neither can read has to be reported the same way by both. A skipped file that
 * is silently counted as an empty one is the failure this type exists to stop.
 */
export interface UnreadableFile {
  /** Path as the reader saw it: absolute for the CLI, picker-relative in the browser. */
  path: string;
  /** Why it was skipped, in words a user can act on. */
  reason: string;
}

/**
 * Which agent wrote the transcript a `SessionStat` came from.
 *
 * The two formats agree on nothing except that they are JSONL: Claude Code
 * records per-message usage on the message, Codex records a running counter on
 * its own event stream. They are read by two different parsers into this one
 * shape, and the tag is what lets a report say which half of a number came from
 * where — which matters most where it is a token count with no dollars behind
 * it, because `prices.json` carries Anthropic rates only.
 */
export type TranscriptSource = 'claude-code' | 'codex';

/** Everything one transcript file yields. Kept small: one of these per transcript. */
export interface SessionStat {
  /**
   * Which agent produced this transcript. Absent means Claude Code.
   *
   * Optional rather than required so the Claude parser is untouched by the
   * addition and an existing consumer keeps working: a stat with no tag is a
   * Claude Code stat, which is what every stat was before Codex was read at all.
   * Read it as `stat.source ?? 'claude-code'`.
   */
  source?: TranscriptSource;
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
  /**
   * Usage-bearing lines that were collapsed into an earlier record for the same
   * `message.id`.
   *
   * Claude Code rewrites a streamed assistant message several times, and every
   * rewrite repeats that message's CUMULATIVE usage. Adding them up multiplies
   * the bill, so only the maximum per field is kept and this counts what was
   * discarded. Zero means the transcript carries one record per message.
   */
  usageRewrites: number;
  /**
   * Usage records that carried no `message.id`, each counted as its own turn.
   *
   * There is nothing to deduplicate such a record against, and the safe
   * direction is to keep it: dropping one loses real spend, while keeping a
   * rewrite that happened to lose its id overstates by one message.
   */
  unidentifiedUsage: number;
  /**
   * Distinct `message.id` values seen in this transcript, in first-appearance
   * order.
   *
   * Deduplication is deliberately scoped to one file. A resumed session copies
   * its parent's history into a new transcript, so the same id legitimately
   * appears in two files; merging them is a different correction with different
   * evidence behind it. This list is what lets the aggregator REPORT that
   * overlap instead of silently applying it.
   */
  messageIds: string[];
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

/**
 * How much of the corpus was repetition rather than spend.
 *
 * Most figures here are counts of records: they exist so a reader can tell a
 * corrected total apart from a wrong one. The cross-file residual is the
 * exception and carries dollars as well, because a count of message ids is not
 * a share of a bill and stating one where the other is meant lets a reader size
 * the remaining error wrongly in either direction.
 */
export interface DeduplicationStats {
  /** Streaming rewrites collapsed into the message they restated. */
  rewritesCollapsed: number;
  /** Usage records with no `message.id`. Each was counted as its own turn. */
  unidentifiedRecords: number;
  /**
   * Message ids that appear in more than one transcript. These are resumed
   * sessions carrying their parent's history, and they are NOT deduplicated —
   * the count is here so the double-count that remains is stated rather than
   * hidden.
   */
  sharedMessageIds: number;
  /** Transcripts holding at least one such id. */
  transcriptsSharingHistory: number;
  /**
   * Redundant COPIES of those messages: an id present in three transcripts
   * contributes two. `sharedMessageIds` counts the message, this counts the
   * duplication, and the two differ whenever an id appears more than twice.
   */
  duplicatedTurns: number;
  /**
   * What those redundant copies are worth, in dollars — the part of `cost.total`
   * that is genuinely counted twice.
   *
   * An ESTIMATE, and it has to be: usage is aggregated per model before it is
   * priced, so no per-message dollar figure survives to be summed. Each
   * duplicated message is valued at the mean cost per turn of the transcripts
   * holding it, and all but one copy of each is charged as redundant.
   *
   * It is here because the alternative was worse. The report used to disclose
   * this residual as a count of message ids and then call it a share of the
   * total above, which is a different quantity in a different unit — the whole
   * point of the disclosure is that a reader can size the remaining error, and
   * they cannot do that from a number that is not denominated in it.
   */
  duplicatedUsd: number;
}

/**
 * What one calendar month cost, and how much of that month the corpus can
 * actually see.
 *
 * `daysCovered` is the honest half. A transcript corpus starts when the oldest
 * surviving transcript starts and ends at the newest, and neither boundary is a
 * month boundary — so the first and last months of any corpus are partial, and
 * the current month always is. A monthly figure read without that is a monthly
 * figure that understates by however much of the month is missing.
 *
 * A session is attributed whole to the month it STARTED in. Sessions that cross
 * a month boundary are rare and splitting one would need per-turn timestamps
 * the aggregator does not carry, so the approximation is stated rather than
 * hidden.
 */
export interface MonthCost {
  /** `YYYY-MM`, UTC. */
  month: string;
  usd: number;
  turns: number;
  sessions: number;
  /** Days of this calendar month the corpus spans. Fractional. */
  daysCovered: number;
  daysInMonth: number;
  /** True only when the corpus covers the month end to end. */
  complete: boolean;
}

/** One month of a plan-utilization report. */
export interface PlanMonth extends MonthCost {
  /**
   * API-equivalent value divided by the plan's monthly price.
   *
   * Null for a metered plan, which has no fee to divide by. On a month where
   * `complete` is false this is an UNDERSTATEMENT and not a small one: the
   * whole month's fee is charged against however little of the month the corpus
   * can see. Such months are shown but never headlined.
   */
  ratio: number | null;
}

/**
 * What a subscription returned, measured against what it cost.
 *
 * The number this exists to produce is a break-even multiple, and the number is
 * only worth printing if it cannot be read as an invoice. Two properties keep
 * it honest, and both are structural rather than editorial:
 *
 * - `ratio` is computed over COMPLETE months only, and is null when there are
 *   none. A multiple derived from half a month is a lie by omission, and the
 *   fixture corpus in this repo is exactly that case.
 * - the denominator is the monthly-billed price, which is the higher one where
 *   a plan offers annual billing, so the multiple comes out smaller.
 */
export interface PlanUtilization {
  /** The id as given to `--plan`. */
  plan: string;
  label: string;
  billing: PlanBilling;
  /** Monthly-billed price used as the denominator. Null when metered. */
  usdPerMonth: number | null;
  /** Annual-billed per-month price, where one is published. */
  usdPerMonthAnnual: number | null;
  perSeat: boolean;
  /** Date the plan prices were read from their source. */
  priceDated: string;
  priceSource: string;
  note: string | null;
  /** Every month the corpus touches, oldest first. */
  months: PlanMonth[];
  /** Months the corpus covers end to end. Only these reach the headline. */
  completeMonths: number;
  /** API-equivalent value across those complete months. */
  completeUsd: number;
  /** What the plan cost across those complete months. Null when metered. */
  completePlanUsd: number | null;
  /**
   * `completeUsd / completePlanUsd`. Null when the plan is metered or when the
   * corpus contains no complete month — never a figure derived from a fragment.
   */
  ratio: number | null;
  /**
   * Value that could not be placed in any month because its transcripts carry
   * no timestamp. It is excluded from every monthly figure above, so a non-zero
   * value here means those figures understate.
   */
  undatedUsd: number;
}

/**
 * What one transcript source contributed, with its pricing coverage stated.
 *
 * This exists because a corpus can now mix agents whose tokens this repo can
 * price with agents whose tokens it cannot. `prices.json` carries Anthropic
 * first-party rates and nothing else, so every Codex turn is counted in `turns`
 * and `usage` and contributes exactly $0 to `usd`. Blending that into one
 * headline would make the dollar figure read as if it covered everything
 * measured, and nothing about it would fail.
 *
 * So the split is reported rather than reconciled: `usage` is a measurement,
 * `usd` is a measurement only for the models named in the price table, and
 * `unpricedModels` names the ones it is not. Inventing OpenAI rates to close the
 * gap would produce a confident wrong number, which is the failure this whole
 * codebase is arranged to avoid.
 */
export interface SourceSummary {
  source: TranscriptSource;
  /** Human-readable name for the agent, for the terminal line and the JSON. */
  label: string;
  transcripts: number;
  /** Top-level sessions; subagent transcripts are excluded, as elsewhere. */
  sessions: number;
  turns: number;
  usage: RawUsage;
  /**
   * API-equivalent dollars for this source. Zero when none of its models carry
   * a rate — which is the current state for every Codex model.
   */
  usd: number;
  /** Model ids seen in this source that have no entry in the price table. */
  unpricedModels: string[];
  /** Turns run on those models. Their tokens are counted; their dollars are not. */
  unpricedTurns: number;
  /** True when every turn in this source ran on a model that carries a rate. */
  fullyPriced: boolean;
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
  /** What the streamed-rewrite correction removed, and what it deliberately did not. */
  deduplication: DeduplicationStats;
  /** Cost per calendar month, oldest first, each carrying its own coverage. */
  byMonth: MonthCost[];
  /**
   * Value from transcripts carrying no timestamp, so placeable in no month.
   *
   * Excluded from every `byMonth` row. Non-zero means the monthly figures are
   * an understatement, which is why it is carried rather than dropped.
   */
  undatedUsd: number;
  /**
   * Plan utilization, present only when `--plan` was given.
   *
   * Optional rather than always-computed because it needs a plan id the user
   * chooses; a report without one is complete on its own terms.
   */
  plan?: PlanUtilization;
  /**
   * Per-source breakdown, present only when a source other than the default was
   * asked for.
   *
   * Absent on a plain Claude Code run on purpose: adding a key to that report
   * would change `--json` output for every existing caller, and a one-row
   * breakdown of a single-source corpus says nothing the totals do not. It
   * appears exactly when the corpus could contain more than one agent, which is
   * the only case where the totals alone are ambiguous.
   */
  bySource?: SourceSummary[];
}
