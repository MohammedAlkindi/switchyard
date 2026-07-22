#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { Command } from 'commander';
import { check } from './commands/check.js';
import { clean } from './commands/clean.js';
import { completion } from './commands/completion.js';
import { diff } from './commands/diff.js';
import { doctor } from './commands/doctor.js';
import { exec } from './commands/exec.js';
import { init, initCheck } from './commands/init.js';
import { list } from './commands/list.js';
import { mcp } from './commands/mcp.js';
import { merge } from './commands/merge.js';
import { pr } from './commands/pr.js';
import { remove } from './commands/remove.js';
import { spawn } from './commands/spawn.js';
import { status } from './commands/status.js';
import { sync, syncAll } from './commands/sync.js';
import { undo } from './commands/undo.js';
import { watch } from './commands/watch.js';
import { FleetError } from './lib/errors.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** Run a command action, mapping expected failures to a clean exit-1 message. */
async function run(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    process.exitCode = 1;
    if (err instanceof FleetError) {
      console.error(chalk.red(`error: ${err.message}`));
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`unexpected error: ${message}`));
    if (process.env.FLEET_DEBUG && err instanceof Error && err.stack) {
      console.error(err.stack);
    } else {
      console.error(chalk.dim('Re-run with FLEET_DEBUG=1 for a stack trace.'));
    }
  }
}

const program = new Command();

// Required for `fleet exec` passThroughOptions; only affects program-level
// options (--version/--help), which must now precede the subcommand.
program.enablePositionalOptions();

program
  .name('fleet')
  .description(
    'Manage multiple AI coding agents working on the same git repository.\n' +
      'Each agent gets an isolated worktree + branch; Switchyard tracks them and\n' +
      'flags file-level collisions before you merge.',
  )
  .version(pkg.version)
  .showHelpAfterError('(run `fleet --help` for usage)');

program
  .command('init')
  .description('set up this repo for the fleet workflow: config, ignore entry, agent docs')
  .option('--force', 'overwrite an existing .fleetrc.json')
  .option('--check', 'verify the artifacts without writing anything (exits 1 on drift)')
  .option('--json', 'print machine-readable JSON instead of the summary')
  .action((opts: { force?: boolean; check?: boolean; json?: boolean }) =>
    run(async () => {
      if (!opts.check) return init(opts);
      if (opts.force) {
        throw new FleetError('`fleet init --check` is read-only; it cannot be combined with --force.');
      }
      const result = await initCheck(opts);
      if (!result.ok) process.exitCode = 1;
    }),
  );

program
  .command('spawn')
  .description('create an isolated worktree + branch (fleet/<name>) for an agent')
  .argument('<agent-name>', 'name for the agent, e.g. claude, codex, cursor')
  .option('--from <branch>', 'base branch to spawn from (default: current branch)')
  .action((name: string, opts: { from?: string }) => run(() => spawn(name, opts)));

program
  .command('list')
  .description('show all active agents: branch, ahead/behind, changes, last activity')
  .option('--json', 'print machine-readable JSON instead of a table')
  .action((opts: { json?: boolean }) => run(() => list(opts)));

program
  .command('status')
  .description("detailed view of one agent's worktree and branch vs its base")
  .argument('<agent-name>', 'agent to inspect')
  .option('--json', 'print machine-readable JSON instead of the summary')
  .action((name: string, opts: { json?: boolean }) => run(() => status(name, opts)));

program
  .command('check')
  .description('flag files touched by more than one agent (exits 1 if any are found)')
  .option('--lines', 'only count files whose edited line ranges actually overlap')
  .option('--files-only', 'skip merge simulation; flag any shared file (v0.1 behavior)')
  .option('--json', 'print machine-readable JSON instead of a table')
  .action((opts: { lines?: boolean; filesOnly?: boolean; json?: boolean }) =>
    run(async () => {
      const result = await check(opts);
      if (result.collisions.length > 0) process.exitCode = 1;
    }),
  );

program
  .command('diff')
  .description("show an agent branch's full diff against its base branch")
  .argument('<agent-name>', 'agent to diff')
  .option('--base <branch>', 'diff against this branch instead of the recorded base')
  .action((name: string, opts: { base?: string }) => run(() => diff(name, opts)));

program
  .command('sync')
  .description("merge an agent's base branch into its branch, catching it up")
  .argument('[agent-name]', 'agent to sync (omit with --all)')
  .option('--all', 'sync every registered agent, continuing past per-agent failures')
  .action((name: string | undefined, opts: { all?: boolean }) =>
    run(async () => {
      if (opts.all) {
        if (name !== undefined) {
          throw new FleetError('Pass either an agent name or --all, not both.');
        }
        const result = await syncAll();
        if (result.failed.length > 0) process.exitCode = 1;
        return;
      }
      if (name === undefined) {
        throw new FleetError('Missing agent name. Pass one, or use --all to sync every agent.');
      }
      return sync(name);
    }),
  );

program
  .command('exec')
  .description("run a shell command inside an agent's worktree (or all worktrees)")
  .argument('[agent-name]', 'agent whose worktree to run in (omit with --all)')
  .argument('[command...]', 'command to run, e.g. `fleet exec claude -- npm test`')
  .option('--all', "run in every agent's worktree, sequentially")
  .passThroughOptions()
  .action((name: string | undefined, command: string[], opts: { all?: boolean }) =>
    run(async () => {
      // With --all the first positional is part of the command, not an agent.
      let tokens = opts.all && name !== undefined ? [name, ...command] : command;
      // commander keeps the literal `--` separator in pass-through args.
      if (tokens[0] === '--') tokens = tokens.slice(1);
      const result = await exec(opts.all ? undefined : name, tokens, { all: opts.all });
      if (!result.ok) process.exitCode = 1;
    }),
  );

program
  .command('pr')
  .description("push an agent's branch to origin and open a pull request via gh")
  .argument('<agent-name>', 'agent to open a PR for')
  .option('--title <title>', 'PR title (default: gh --fill from the last commit)')
  .option('--base <branch>', "PR base branch (default: the agent's recorded base)")
  .option('--draft', 'open the PR as a draft')
  .action((name: string, opts: { title?: string; base?: string; draft?: boolean }) =>
    run(() => pr(name, opts)),
  );

program
  .command('watch')
  .description('live-updating `fleet list`, re-rendered on an interval until Ctrl+C')
  .option('--interval <seconds>', 'refresh interval in seconds (default: 3)', parseFloat)
  .action((opts: { interval?: number }) => run(() => watch(opts)));

program
  .command('merge')
  .description("merge an agent's branch into the current branch, then clean up the agent")
  .argument('<agent-name>', 'agent to merge')
  .option('--delete-branch', 'delete the branch after merging (already the default cleanup)')
  .option('--no-clean', 'keep the worktree and branch after merging')
  .action((name: string, opts: { deleteBranch?: boolean; clean?: boolean }) =>
    run(() => merge(name, opts)),
  );

program
  .command('undo')
  .description('roll back the last fleet merge: branch pointer, agent branch, worktree, state')
  .action(() => run(() => undo()));

program
  .command('doctor')
  .description('diagnose state/reality drift; exits 1 if problems remain unfixed')
  .option('--fix', 'repair what can be repaired (rebuild state, adopt/remove orphans, prune stale entries)')
  .option('--json', 'print machine-readable JSON instead of the report')
  .action((opts: { fix?: boolean; json?: boolean }) =>
    run(async () => {
      const result = await doctor(opts);
      if (!result.healthy) process.exitCode = 1;
    }),
  );

program
  .command('mcp')
  .description('serve the read-only fleet tools to an AI agent over MCP (stdio)')
  .action(() => run(() => mcp()));

program
  .command('completion')
  .description('output a shell completion script (agent names are a snapshot)')
  .argument('<shell>', 'bash, zsh, or fish')
  .action((shell: string) => run(() => completion(shell)));

program
  .command('remove')
  .description("remove an agent's worktree (branch is kept unless --delete-branch)")
  .argument('<agent-name>', 'agent to remove')
  .option('--force', 'discard uncommitted changes / delete an unmerged branch')
  .option('--delete-branch', "also delete the agent's fleet/<name> branch")
  .action((name: string, opts: { force?: boolean; deleteBranch?: boolean }) =>
    run(() => remove(name, opts)),
  );

program
  .command('clean')
  .description('remove agents whose branches are fully merged into their base')
  .option('--dry-run', 'list what would be cleaned without removing anything')
  .option(
    '--stale <days>',
    'also remove agents idle for this many days (clean worktree only; branch kept)',
    parseFloat,
  )
  .action((opts: { dryRun?: boolean; stale?: number }) => run(() => clean(opts)));

program.addHelpText(
  'after',
  '\nExamples:\n' +
    '  fleet init                      set this repo up for the fleet workflow\n' +
    '  fleet init --check              verify that setup in CI; exits 1 on drift\n' +
    '  fleet spawn claude              spawn an agent off the current branch\n' +
    '  fleet spawn codex --from main   spawn a second agent off main\n' +
    '  fleet check --lines             any files touched by both, line-precise?\n' +
    '  fleet sync claude               catch fleet/claude up with its base\n' +
    '  fleet sync --all                catch every agent up after a merge\n' +
    '  fleet exec claude -- npm test   run tests inside the claude worktree\n' +
    '  fleet diff claude               review before merging fleet/claude\n' +
    '  fleet merge claude              merge fleet/claude and clean it up\n' +
    '  fleet pr claude                 push fleet/claude and open a PR via gh\n' +
    '  fleet remove codex --force      drop a worktree, discarding its changes\n' +
    '  fleet clean --stale 14          sweep merged agents + 2-week-idle ones\n' +
    '  fleet doctor --fix              repair state drift after manual surgery\n' +
    '  fleet list --json               agent table as JSON, for scripts and CI\n' +
    '  fleet mcp                       serve read-only fleet tools to an agent\n',
);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
