import { DEFAULT_WATCH_INTERVAL, readConfig } from '../lib/config.js';
import type { FleetConfig } from '../lib/config.js';
import { FleetError } from '../lib/errors.js';
import { CLEAR_SCREEN, dim } from '../lib/format.js';
import { getMainRepoRoot } from '../lib/git.js';
import { buildListTable, collectListings } from './list.js';

export interface WatchOptions {
  /** Refresh interval in seconds. Defaults to .fleetrc.json `watchInterval`, then 3. */
  interval?: number;
  cwd?: string;
}

/** Precedence: --interval flag > .fleetrc.json watchInterval > built-in default. */
export function resolveWatchInterval(flag: number | undefined, config: FleetConfig): number {
  if (flag !== undefined && (!Number.isFinite(flag) || flag <= 0)) {
    throw new FleetError('Invalid --interval. Pass a positive number of seconds, e.g. --interval 5.');
  }
  return flag ?? config.watchInterval ?? DEFAULT_WATCH_INTERVAL;
}

/** One frame of `fleet watch`: a header plus the exact table `fleet list` prints. */
export async function renderWatchFrame(
  options: { cwd?: string } = {},
  now: Date = new Date(),
): Promise<string> {
  const listings = await collectListings(options);
  const header = dim(`fleet watch — ${now.toISOString().slice(11, 19)} UTC — Ctrl+C to exit`);
  const body =
    listings.length === 0
      ? 'No active agents. Run `fleet spawn <name>` to create one.'
      : buildListTable(listings);
  return `${header}\n${body}`;
}

/** Re-render `fleet list` on an interval until Ctrl+C. */
export async function watch(options: WatchOptions = {}): Promise<never> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await getMainRepoRoot(cwd);
  const config = readConfig(repoRoot);
  const intervalSeconds = resolveWatchInterval(options.interval, config);

  const render = async (): Promise<void> => {
    const frame = await renderWatchFrame({ cwd });
    process.stdout.write(CLEAR_SCREEN);
    console.log(frame);
    console.log(dim(`refreshing every ${intervalSeconds}s`));
  };

  await render();
  // Chained timeouts rather than setInterval, so a render that takes longer
  // than the interval can never overlap the next one. Resolves never; the
  // process ends on Ctrl+C (or the promise rejects on a render error).
  return new Promise<never>((_resolve, reject) => {
    const scheduleNext = (): void => {
      setTimeout(() => {
        render().then(scheduleNext, reject);
      }, intervalSeconds * 1000);
    };
    scheduleNext();
  });
}
