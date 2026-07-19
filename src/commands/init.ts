import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from '../lib/config.js';
import { ensureFleetExcluded, getMainRepoRoot } from '../lib/git.js';
import { bold, dim, ok } from '../lib/format.js';
import { withLock } from '../lib/lock.js';
import {
  AGENTS_BLOCK,
  AGENTS_MD_FILE,
  SKILL_INSTALL_PATH,
  readPackagedSkill,
  upsertMarkedBlock,
} from '../lib/protocol.js';

export interface InitOptions {
  /** Overwrite `.fleetrc.json` when it already exists. */
  force?: boolean;
  json?: boolean;
  cwd?: string;
}

/**
 * What init did to one path.
 *
 * `kept` is the only outcome that means "your file was left alone because
 * replacing it needs --force"; `unchanged` means the content was already right.
 */
export type InitAction = 'created' | 'updated' | 'unchanged' | 'kept';

export interface InitStep {
  /** Repo-root-relative, forward slashes. */
  path: string;
  action: InitAction;
  note?: string;
}

export interface InitResult {
  repoRoot: string;
  steps: InitStep[];
}

const STARTER_CONFIG = `{
  "$schema": "https://unpkg.com/@switchyardhq/switchyard/schema/fleetrc.schema.json"
}
`;

/** Write only when the content would actually change, so re-runs stay quiet. */
function writeIfChanged(file: string, content: string): InitAction {
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') === content) return 'unchanged';
    writeFileSync(file, content, 'utf8');
    return 'updated';
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return 'created';
}

/**
 * Bring a repository into the fleet workflow: config, ignore entry, and the
 * two artifacts that teach agents the convention.
 *
 * The split between what init overwrites and what it protects is deliberate.
 * `.fleetrc.json` is the user's file and is never clobbered without --force.
 * The skill and the AGENTS.md block are package-managed content, refreshed on
 * every run — a stale convention is the failure this command exists to fix.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
  return withLock(repoRoot, 'init', () => initLocked(options, repoRoot));
}

async function initLocked(options: InitOptions, repoRoot: string): Promise<InitResult> {
  const steps: InitStep[] = [];

  // First, so a repo that has never spawned still stops tracking .fleet/.
  const excluded = await ensureFleetExcluded(repoRoot);
  steps.push({
    path: '.git/info/exclude',
    action: excluded ? 'updated' : 'unchanged',
    note: '.fleet/ is ignored',
  });

  const configFile = path.join(repoRoot, CONFIG_FILE);
  if (existsSync(configFile) && !options.force) {
    steps.push({ path: CONFIG_FILE, action: 'kept', note: 'already exists; --force overwrites' });
  } else {
    steps.push({ path: CONFIG_FILE, action: writeIfChanged(configFile, STARTER_CONFIG) });
  }

  const skillFile = path.join(repoRoot, ...SKILL_INSTALL_PATH.split('/'));
  steps.push({ path: SKILL_INSTALL_PATH, action: writeIfChanged(skillFile, readPackagedSkill()) });

  const agentsFile = path.join(repoRoot, AGENTS_MD_FILE);
  const existingAgents = existsSync(agentsFile) ? readFileSync(agentsFile, 'utf8') : '';
  steps.push({
    path: AGENTS_MD_FILE,
    action: writeIfChanged(agentsFile, upsertMarkedBlock(existingAgents, AGENTS_BLOCK)),
    note: existingAgents === '' ? undefined : 'switchyard block only; the rest is untouched',
  });

  const result: InitResult = { repoRoot, steps };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log(ok(`Initialized Switchyard in ${bold(repoRoot)}`));
  for (const step of steps) {
    const label = step.action.padEnd(9);
    console.log(`  ${label} ${step.path}${step.note ? ` ${dim(`(${step.note})`)}` : ''}`);
  }
  console.log('');
  console.log('Next:');
  console.log(`  fleet spawn claude              ${dim('give an agent its own worktree')}`);
  console.log(`  fleet check                     ${dim('see what two agents both touched')}`);
  console.log('');
  console.log(dim('Re-run `fleet init` after upgrading to refresh the agent-facing docs.'));

  return result;
}
