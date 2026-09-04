/**
 * The library entry point: `import { ... } from 'contextbill'`.
 *
 * It exists so another tool — a statusline, a dashboard, a CI check — can call
 * the analysis directly instead of spawning the CLI and scraping its text. Text
 * output is a presentation choice and it changes; these functions and the types
 * in `types.ts` are the part callers may depend on.
 *
 * ---------------------------------------------------------------------------
 * NOTHING REACHED FROM HERE MAY TOUCH THE FILESYSTEM
 * ---------------------------------------------------------------------------
 *
 * `scan.ts` (which imports `node:fs`) and `cli.ts` (which owns `process`) are
 * deliberately absent, and re-exporting either one from this file breaks the
 * property that makes it useful: this module graph bundles for a browser, which
 * is the same reason `parse.ts` is kept clear of Node built-ins. The web app
 * already depends on that split; a library export that quietly pulled `node:fs`
 * back in would break it at bundle time, in someone else's build, with a stack
 * trace pointing at us.
 *
 * `entry.test.ts` walks the import graph from this file and fails on any
 * `node:` specifier, because nothing else here notices.
 *
 * Reading transcripts off disk is the caller's half of the job, and it is four
 * lines: read the file, hand the text to `parseTranscript`, price the result.
 * The README shows it.
 */

// Parsing — text in, one SessionStat out. Both parsers are pure.
export { parseTranscript } from './parse.js';
export type { ParseOptions } from './parse.js';
export { parseCodexRollout } from './codex-parse.js';
export type { CodexParseOptions } from './codex-parse.js';

// Pricing — a PriceTable plus per-model usage in, dollars out. `priceAll`
// returns the models it could NOT price rather than folding them in as zero;
// callers have to surface that or their totals quietly under-report.
export {
  addCost,
  addUsage,
  cacheWriteMultiplier,
  normalizeModelId,
  priceAll,
  priceModelUsage,
  rateInForce,
  usd,
  zeroCost,
  zeroUsage,
} from './cost.js';
export type { PricedTotals, RateInForce } from './cost.js';

// Aggregation — many SessionStats in, one Report out.
export { aggregate, monthlyProjection, planUtilization, startupPrefixCost } from './aggregate.js';
export type { AggregateOptions } from './aggregate.js';

// Tool classification, used to attribute spend to browser / file / shell / MCP.
export { classify, isMutatingTool, mcpServer } from './classify.js';

// Project-slug redaction. A raw slug encodes an OS username and directory tree,
// so anything rendered for another pair of eyes goes through `redactProject`.
export { homeSlug, projectSlugFromPath, redactProject } from './privacy.js';

// Waste heuristics and the thresholds behind them, exported so a caller can see
// what "long session" and "dead run" actually mean rather than guessing.
export {
  bucketFor,
  buildFindings,
  deadRuns,
  DEAD_RUN_BYTES,
  DEAD_RUN_TURNS,
  LONG_SESSION_TURNS,
  medianStartupPrefix,
  noFileWritten,
  turnBuckets,
  TURN_BUCKETS,
} from './waste.js';

// The HTML renderer. Pure: Report in, string out, no file written.
export { renderReport } from './report.js';

// Every interface and union the functions above accept or return.
export type * from './types.js';
