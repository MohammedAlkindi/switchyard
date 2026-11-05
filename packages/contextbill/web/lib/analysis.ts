/**
 * The single import surface for the analysis core.
 *
 * These modules live at the repository root in `src/` and are shared verbatim
 * with the CLI — there is one implementation of pricing and aggregation, not
 * two. Everything re-exported here is pure and Node-free; `scan.ts` is
 * deliberately NOT re-exported because it reads the filesystem. The browser
 * gets its own reader in `lib/browser-scan.ts`.
 */
export { classify, isMutatingTool } from '@core/classify';
export {
  addCost,
  addUsage,
  cacheWriteMultiplier,
  normalizeModelId,
  priceAll,
  priceModelUsage,
  usd,
  zeroCost,
  zeroUsage,
} from '@core/cost';
export { aggregate, monthlyProjection, startupPrefixCost } from '@core/aggregate';
export {
  bucketFor,
  buildFindings,
  deadRuns,
  medianStartupPrefix,
  noFileWritten,
  turnBuckets,
  DEAD_RUN_BYTES,
  DEAD_RUN_TURNS,
  LONG_SESSION_TURNS,
} from '@core/waste';
export { homeSlug, redactProject } from '@core/privacy';
export { renderReport } from '@core/report';

export type {
  CacheTtl,
  CategoryCost,
  CostBreakdown,
  DeadRun,
  Findings,
  ModelPrice,
  ModelUsage,
  PriceTable,
  RawUsage,
  Report,
  SessionCost,
  SessionStat,
  ToolCategory,
  TurnBucket,
} from '@core/types';
