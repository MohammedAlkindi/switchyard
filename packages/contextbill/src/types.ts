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
  /**
   * The Anthropic reading date, kept for tables written before the second
   * vendor landed. It cannot describe both vendors — read `datedByProvider`.
   */
  dated: string;
  /**
   * When the rates for each vendor were read, and from where. Optional so a
   * hand-made or pre-2026-09-07 table still type-checks.
   */
  datedByProvider?: Record<string, { dated: string; source: string }>;
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

/**
 * One billed assistant message, identified well enough to be recognised in a
 * DIFFERENT transcript.
 *
 * A resumed session copies its parent's transcript lines forward verbatim, so
 * the same request is on disk twice. `message.id` alone cannot prove that: an
 * API gateway can hand the same id to two genuinely independent sessions, and
 * merging those under-counts real spend. The per-line `uuid` closes it. It is
 * minted by whoever wrote the line, a copy carries it over unchanged, and two
 * sessions that never copied from each other cannot mint the same one — so
 * (`id`, `uuid`) identifies a billed message across files while `id` alone only
 * suggests it.
 *
 * `uuid` is the FIRST one written for the message, not the last. A message is
 * streamed into the transcript over several lines, each with its own uuid, and
 * a copy that ends earlier than the original still shares the opening line.
 *
 * `usage` is the collapsed figure — the maximum per field across that message's
 * rewrites — so nothing a merge moves between transcripts can resurrect a
 * rewrite that was already discarded.
 */
export interface BilledMessage {
  id: string;
  /** First line-level `uuid` written for this message. */
  uuid: string;
  usage: RawUsage;
  /** Null when no line of the message named a model. */
  model: string | null;
  speed: 'standard' | 'fast';
  /** Epoch ms of the message's earliest line, or null when it carried no clock. */
  at: number | null;
}

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
   * Rewrite collapsing is scoped to one file, and stays that way: this list is
   * what lets a corpus-level pass see which ids a transcript holds at all. It
   * is the count behind the residual disclosure — ids held by more than one
   * transcript that `billedMessages` could NOT prove were copies.
   */
  messageIds: string[];
  /**
   * The same messages again, carrying what it takes to recognise one in another
   * transcript: the first line `uuid`, the collapsed usage, and the model.
   *
   * A message with an id but no `uuid` is absent here on purpose. There is
   * nothing to prove a copy with, so it is never merged and stays counted where
   * it is — the same under-correcting direction the id-less records take.
   *
   * Optional for the same reason `source` is: a Codex rollout carries no message
   * ids at all, so its parser sets neither, and `stat.billedMessages ?? []` is
   * the correct read everywhere. Read it as "what this file can offer a
   * corpus-level pass", not as a second copy of `usage`.
   */
  billedMessages?: BilledMessage[];
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
   * Billed messages that were found in more than one transcript AND proved to
   * be copies, so were counted once.
   *
   * The proof is the line `uuid`: a resumed session copies its parent's lines
   * forward unchanged, and a uuid cannot be minted twice. See `BilledMessage`.
   */
  crossFileMessagesMerged: number;
  /**
   * Redundant COPIES removed. A message present in three transcripts
   * contributes two, so this is what came off the totals, while
   * `crossFileMessagesMerged` counts the messages behind it.
   */
  crossFileCopiesMerged: number;
  /** Transcripts that lost at least one copied message. */
  crossFileTranscriptsCorrected: number;
  /**
   * What those removed copies were worth — the double-count that is now gone.
   *
   * NOT an estimate, unlike `duplicatedUsd`: the removed copies are known per
   * message, so they are priced as themselves at their own model and rate.
   */
  crossFileUsdMerged: number;
  /**
   * Message ids STILL held by more than one transcript after the merge above.
   *
   * These are the ones the merge refused: the id matched but no `uuid` did, so
   * nothing proves the two records are the same request. The two known causes
   * pull in opposite directions — an API gateway handing one id to two
   * independent sessions (where merging would under-count real spend), and a
   * streamed rewrite the writer scattered into a sibling subagent file (where
   * merging would be right). Neither is distinguishable from the other, so the
   * copies are left in place and the double-count that remains is stated rather
   * than hidden.
   */
  sharedMessageIds: number;
  /** Transcripts holding at least one such unmerged id. */
  transcriptsSharingHistory: number;
  /**
   * Redundant COPIES of those unmerged messages: an id present in three
   * transcripts contributes two. `sharedMessageIds` counts the message, this
   * counts the duplication, and the two differ whenever an id appears more than
   * twice.
   */
  duplicatedTurns: number;
  /**
   * What those redundant copies are worth, in dollars — the part of `cost.total`
   * that is still counted twice after the merge.
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
 * A session that crosses a month boundary is SPLIT between the months, by the
 * timestamp each of its `ModelUsage` rows carries. Those rows are bucketed to
 * one UTC day and a UTC day never straddles a month boundary, so the dollars
 * either side are separated exactly rather than apportioned by a rule.
 *
 * It was not always so, and the bias it left is worth keeping recorded because
 * it ran in the one direction this feature promises never to err in. A session
 * used to be booked whole to the month it STARTED in, so work done in month M+1
 * was credited to M; and since `ratio` on `PlanUtilization` is computed over
 * COMPLETE months only, value dragged backwards out of a partial month landed in
 * the numerator of a headline that month is excluded from. The size was
 * corpus-dependent and unbounded in principle — a session opening a minute
 * before a month ends carried however much it went on to cost back across the
 * boundary with it.
 *
 * Two things still do not divide, and both are deliberate. `sessions` counts a
 * session once, in the month it opened: turns and dollars are quantities, a
 * session is not. And a row whose transcript lines carried no readable
 * timestamp falls back to that same month, because a neighbouring row's clock
 * is not evidence of when it ran — the same rule `cost.ts` applies when it
 * prices such a row.
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
  /**
   * Reading date per vendor. The report names the vendors whose rates were
   * actually applied, so it needs their dates rather than one table-wide one:
   * quoting the Anthropic date beside a Codex total states a reading that
   * never happened.
   */
  priceTableDatedByProvider?: Record<string, string>;
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

/* -------------------------------------------------------------------------- *
 * Subscription rate-limit windows
 *
 * Every other number in this file is derived from a transcript. These are not:
 * Claude Code reads them off the `anthropic-ratelimit-unified-*` response
 * headers and hands them to a statusline command on stdin, which makes them the
 * only ground truth this tool can get about how much of a plan window is gone.
 *
 * The distinction between what was reported and what was extrapolated from it
 * is kept STRUCTURAL rather than editorial: a measured figure lives on
 * `RateLimitWindow` and a projected one lives on `LimitProjection`, and nothing
 * carries both. Labelling would have been cheaper and would have rotted — the
 * tools this feature competes with blur exactly this line, which is why their
 * five-hour estimates disagree with the limits people actually hit.
 * -------------------------------------------------------------------------- */

/** The rate-limit windows the statusline payload can carry. */
export type LimitWindowId = 'five_hour' | 'seven_day' | 'spend_limit';

/**
 * One window exactly as Claude Code reported it. Every field here is MEASURED.
 *
 * `windowMs` is the one derived value, and it is derived from the window's
 * documented length rather than from any observation — `five_hour` is five
 * hours. It is null for `spend_limit`, whose period is not documented anywhere
 * this tool can cite, and a null there switches off every projection rather
 * than inviting one.
 */
export interface RateLimitWindow {
  id: LimitWindowId;
  /** Full name, for the terminal block. */
  label: string;
  /** Two or three characters, for a prompt line. */
  shortLabel: string;
  /** Percent of the window consumed, 0-100. Above 100 once a limit is passed. */
  usedPercent: number;
  /** Epoch ms at which the window resets. The payload states this in seconds. */
  resetsAtMs: number;
  /** Documented length of the window, ms. Null when there is no documented one. */
  windowMs: number | null;
}

/**
 * What follows from a window if the pace so far continues. Every field here is
 * PROJECTED, apart from `msToReset` and `stale`, which are arithmetic on two
 * measured numbers and a clock.
 *
 * The projection is a straight line and nothing more: percent consumed divided
 * by window time elapsed, extended to 100. Real usage is bursty, so this is a
 * pace, not a forecast, and it is worth printing only because it is anchored to
 * a measured percentage rather than to a guess about when the window opened.
 */
export interface LimitProjection {
  /** Ms from now until the reset. Measured, up to the local clock. */
  msToReset: number;
  /** True when the reset has already passed, so the sample describes a dead window. */
  stale: boolean;
  /** Epoch ms the window opened, from `resetsAtMs - windowMs`. Null when unknown. */
  startedAtMs: number | null;
  /** Percentage points consumed per hour, averaged since the window opened. */
  percentPerHour: number | null;
  /**
   * Epoch ms at which this pace reaches 100%.
   *
   * Null when there is nothing to extrapolate from: no documented window
   * length, a stale sample, or a pace of zero — zero never reaches 100, and a
   * date implying it would is worse than no date.
   */
  exhaustedAtMs: number | null;
  /** True when exhaustion is projected to arrive before the reset does. */
  exhaustsBeforeReset: boolean;
}

/** One window with its projection, kept in separate objects on purpose. */
export interface LimitWindowView {
  window: RateLimitWindow;
  projection: LimitProjection;
}

/**
 * What the local transcripts say was spent inside a window.
 *
 * Measured from transcripts, over an interval whose START is derived: the
 * window's opening is `resetsAtMs - windowMs`, not something any transcript
 * records. Selection is by file mtime, so a transcript that began before the
 * window opened and was appended to inside it is counted in FULL — the same
 * approximation `--scope today` makes, and it is stated for the same reason.
 *
 * This is deliberately NOT reconciled with `usedPercent`. The plan window is
 * weighted by rules this tool cannot see; API-equivalent dollars are a
 * different quantity in a different unit, and presenting one as a check on the
 * other would be the confident wrong number this codebase is arranged to avoid.
 */
export interface LocalWindowSpend {
  windowId: LimitWindowId;
  /** Epoch ms the window opened. Derived, see above. */
  sinceMs: number;
  /** Transcript files touched since then. */
  transcripts: number;
  turns: number;
  /** API-equivalent dollars across those transcripts. */
  usd: number;
  /** Those dollars over the hours elapsed since the window opened. */
  usdPerHour: number;
}

/**
 * The answer `--limits` prints: every window Claude Code reported, what the
 * local corpus spent inside the binding one, and the instant it was all read.
 *
 * There is no "no windows" case to represent — the caller has nothing to build
 * this from when the payload carried none, and says so instead of rendering an
 * empty view that looks like a measurement of zero.
 */
export interface LimitReport {
  /** Epoch ms the payload was read. Every projection is relative to this. */
  observedAt: number;
  windows: LimitWindowView[];
  /** Local spend inside the binding window. Null when it has no known length. */
  local: LocalWindowSpend | null;
}
