import { readConfig } from '../lib/config.js';
import { CLEAR_SCREEN, dim, fail, ok, warn } from '../lib/format.js';
import { getMainRepoRoot, gitAt, supportsMergeTree } from '../lib/git.js';
import { buildCheckReport, collectCheck } from './check.js';
import type { CheckResult } from './check.js';
import { buildListTable, collectListings } from './list.js';
import type { AgentListing } from './list.js';
import { resolveWatchInterval } from './watch.js';

export interface DashboardOptions {
  /** Refresh interval in seconds. Defaults to .fleetrc.json `watchInterval`, then 3. */
  interval?: number;
  /** Print a single frame and exit — for scripts, CI logs, and non-TTY use. */
  once?: boolean;
  cwd?: string;
}

/** Everything one dashboard frame is rendered from. */
export interface DashboardData {
  listings: AgentListing[];
  check: CheckResult;
  /** Whether the installed git can run merge-tree simulation (hint text only). */
  capable: boolean;
}

/** Gather one frame's data: the list and the collision report, concurrently. */
export async function collectDashboard(cwd?: string): Promise<DashboardData> {
  const repoRoot = await getMainRepoRoot(cwd ?? process.cwd());
  const [listings, check, capable] = await Promise.all([
    collectListings({ cwd: repoRoot }),
    collectCheck({ cwd: repoRoot }),
    supportsMergeTree(gitAt(repoRoot)),
  ]);
  return { listings, check, capable };
}

/**
 * Render one dashboard frame: the `fleet list` table (validation column
 * included), per-agent touched-file counts, a validation tally, and the full
 * `fleet check` report. Pure, like the collect/build pairs it composes.
 */
export function buildDashboard(data: DashboardData, now: Date = new Date()): string {
  const { listings, check, capable } = data;
  const header = dim(
    `fleet dashboard — ${now.toISOString().slice(11, 19)} UTC — Ctrl+C to exit`,
  );
  if (listings.length === 0) {
    return `${header}\nNo active agents. Run \`fleet spawn <name>\` to create one.`;
  }

  const out: string[] = [header, '', buildListTable(listings)];

  const touched = listings
    .map((l) => `${l.name} ${check.agentFiles[l.name] ?? 0}`)
    .join(' · ');
  out.push(dim(`files touched vs base: ${touched}`));

  const tally = { passed: 0, failed: 0, stale: 0, none: 0 };
  for (const l of listings) tally[l.validation] += 1;
  const parts: string[] = [];
  if (tally.passed > 0) parts.push(ok(`${tally.passed} passed`));
  if (tally.failed > 0) parts.push(fail(`${tally.failed} failed`));
  if (tally.stale > 0) parts.push(warn(`${tally.stale} stale`));
  if (tally.none > 0) parts.push(dim(`${tally.none} unvalidated`));
  out.push(`validation: ${parts.join(' · ')}`);

  out.push('', buildCheckReport(check, { capable }));
  return out.join('\n');
}

/**
 * One live pane for the whole fleet: who is doing what, who is green, and
 * what would collide — the `list`, `validate`, and `check` answers together,
 * re-rendered on an interval. `--once` prints a single frame instead.
 */
export async function dashboard(options: DashboardOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await getMainRepoRoot(cwd);
  const config = readConfig(repoRoot);
  const intervalSeconds = resolveWatchInterval(options.interval, config);

  if (options.once) {
    console.log(buildDashboard(await collectDashboard(cwd)));
    return;
  }

  const render = async (): Promise<void> => {
    const frame = buildDashboard(await collectDashboard(cwd));
    process.stdout.write(CLEAR_SCREEN);
    console.log(frame);
    console.log(dim(`refreshing every ${intervalSeconds}s`));
  };

  await render();
  // Chained timeouts, not setInterval: a frame that takes longer than the
  // interval (merge simulation on a big fleet) can never overlap the next.
  return new Promise<never>((_resolve, reject) => {
    const scheduleNext = (): void => {
      setTimeout(() => {
        render().then(scheduleNext, reject);
      }, intervalSeconds * 1000);
    };
    scheduleNext();
  });
}
