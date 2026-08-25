#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { aggregate, monthlyProjection } from './aggregate.js';
import { cacheWriteMultiplier, usd } from './cost.js';
import { redactProject } from './privacy.js';
import { renderReport } from './report.js';
import { scanAll } from './scan.js';
import type { CacheTtl, PriceTable } from './types.js';

/**
 * The only module here that touches the filesystem or the process. Everything
 * it calls is pure, which is what makes the rest of the codebase testable
 * without fixtures on disk.
 *
 * Two operational rules inherited from the reference implementation, both
 * deliberate:
 *   - Transcripts are opened read-only. Never write into the directory being
 *     measured; a live session may hold those files.
 *   - Always exit 0. This is a reporting tool; failing a caller's pipeline
 *     because a measurement did not work is worse than printing nothing.
 */

const HELP = `loadline — what your coding agents actually cost

USAGE
  loadline [options]

OPTIONS
  --root <dir>       Transcript root. Default: ~/.claude/projects
  --out <file>       Report path. Default: ./loadline-report.html
  --cache-ttl <ttl>  Cache-write billing rate: 5m (default) or 1h.
                     Transcripts don't record this. 5m is the conservative
                     choice — if your client used 1h caching, the real cost
                     is higher than reported.
  --json             Print the report as JSON to stdout, write no file.
  --top <n>          Sessions in the "most expensive" table. Default: 20.
  --show-paths       Show full project directory slugs. Off by default: those
                     slugs encode your OS username and directory tree, and the
                     report is meant to be shared.
  --version          Print version.
  --help             This text.

loadline reads transcripts and writes one HTML file. It opens no sockets.
`;

interface Options {
  root: string;
  out: string;
  ttl: CacheTtl;
  json: boolean;
  top: number;
  showPaths: boolean;
  help: boolean;
  version: boolean;
  /** Flags we did not recognise. Surfaced so a typo is not silently ignored. */
  unknown: string[];
}

export function parseArgs(argv: readonly string[], home: string): Options {
  const opts: Options = {
    root: path.join(home, '.claude', 'projects'),
    out: path.resolve('loadline-report.html'),
    ttl: '5m',
    json: false,
    top: 20,
    showPaths: false,
    help: false,
    version: false,
    unknown: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const [flag, inlineValue] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const next = (): string | undefined => inlineValue ?? argv[++i];

    switch (flag) {
      case '--root': {
        const v = next();
        if (v !== undefined) opts.root = path.resolve(v);
        break;
      }
      case '--out': {
        const v = next();
        if (v !== undefined) opts.out = path.resolve(v);
        break;
      }
      case '--cache-ttl': {
        const v = next();
        if (v === '1h' || v === '5m') opts.ttl = v;
        break;
      }
      case '--top': {
        const v = next();
        const parsedTop = v === undefined ? NaN : Number.parseInt(v, 10);
        if (Number.isFinite(parsedTop) && parsedTop > 0) opts.top = parsedTop;
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--show-paths':
        opts.showPaths = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
      case '-v':
        opts.version = true;
        break;
      default:
        // Anything flag-shaped we do not know is a typo, not a no-op.
        if (flag !== undefined && flag.startsWith('-')) opts.unknown.push(flag);
        break;
    }
  }
  return opts;
}

function loadPriceTable(): PriceTable {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli.js -> ../prices.json at the package root.
  const candidates = [
    path.join(here, '..', 'prices.json'),
    path.join(here, 'prices.json'),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')) as PriceTable;
    } catch {
      continue;
    }
  }
  throw new Error('prices.json not found next to the loadline package');
}

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const raw = fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Write via temp + rename so a reader never sees a half-written report. */
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function main(): void {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
  const opts = parseArgs(process.argv.slice(2), home);

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  if (opts.unknown.length > 0) {
    process.stderr.write(
      `loadline: ignoring unrecognised flag(s): ${opts.unknown.join(', ')}\n` +
        'Run "loadline --help" for the supported options.\n\n',
    );
  }

  if (!fs.existsSync(opts.root)) {
    process.stderr.write(
      `loadline: no transcripts at ${opts.root}\n` +
        `Point --root at a directory of .jsonl transcripts.\n`,
    );
    return;
  }

  const table = loadPriceTable();
  const scanned = scanAll(opts.root);

  // Project slugs encode the OS username and directory tree. The report exists
  // to be shared, so redaction is the default and showing them is opt-in.
  const stats = opts.showPaths
    ? scanned
    : scanned.map((s) => ({ ...s, project: redactProject(s.project, home) }));

  if (stats.length === 0) {
    process.stderr.write(`loadline: found no .jsonl transcripts under ${opts.root}\n`);
    return;
  }

  const report = aggregate(stats, {
    table,
    ttl: opts.ttl,
    cacheWriteMult: cacheWriteMultiplier(table, opts.ttl),
    topN: opts.top,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  // Transcripts were present but nothing billable parsed out of them. Printing
  // "$0.00" here would read as a real answer when it is a parse failure — the
  // exact confident-wrong-number this tool exists to prevent.
  if (report.turns === 0) {
    process.stderr.write(
      `loadline: read ${stats.length} transcript file(s) under ${opts.root}, ` +
        'but found no usage data in any of them.\n' +
        'That usually means this is not a Claude Code transcript root, or the ' +
        'files are in a format this version does not understand.\n' +
        'No report written.\n',
    );
    return;
  }

  writeAtomic(opts.out, renderReport(report));

  const f = report.findings;
  const lines = [
    '',
    `  ${usd(report.cost.total)} across ${report.turns.toLocaleString('en-US')} turns in ${report.sessionCount.toLocaleString('en-US')} sessions`,
    `  ${usd(monthlyProjection(report))} projected per 30 days`,
    `  ${f.medianStartupPrefix.toLocaleString('en-US')} median tokens loaded before you type — ${usd(f.startupPrefixUsd)} paid for that alone`,
    '',
  ];
  if (f.noFileWritten.length > 0) {
    lines.push(`  ${f.noFileWritten.length} long session(s) wrote no file — see the report`);
  }
  if (f.deadRuns.length > 0) {
    lines.push(`  ${f.deadRuns.length} run(s) look like they died on startup`);
  }
  if (report.unpricedModelsSeen.length > 0) {
    lines.push(`  unpriced models excluded: ${report.unpricedModelsSeen.join(', ')}`);
  }
  lines.push('', `  report -> ${opts.out}`, '');

  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Only run when invoked as the binary, never on import.
 *
 * Without this guard, importing anything from this module executes the whole
 * CLI and then calls process.exit — which makes `parseArgs` untestable and
 * would surprise any consumer that imported it.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return pathToFileURL(path.resolve(invoked)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`loadline failed (non-fatal): ${message}\n`);
  }
  process.exit(0);
}
