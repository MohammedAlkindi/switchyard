import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FleetError } from './errors.js';

/**
 * Optional per-repo defaults from `.fleetrc.json` at the repo root.
 * Precedence everywhere: CLI flag > `.fleetrc.json` > built-in default.
 */
export interface FleetConfig {
  /** Default base branch for `fleet spawn` when --from is not passed. */
  defaultBase?: string;
  /** Default refresh interval for `fleet watch`, in seconds. */
  watchInterval?: number;
  /** Run a `fleet clean` sweep after every successful `fleet merge`. */
  autoClean?: boolean;
  /**
   * Repo-root-relative files/directories copied into every new worktree by
   * `fleet spawn` — the gitignored essentials a fresh worktree lacks (.env, …).
   */
  copyOnSpawn?: string[];
  /** Shell command run inside a new worktree after `fleet spawn` (e.g. "npm ci"). */
  postSpawn?: string;
  /**
   * Shell command run inside the agent's worktree before `fleet merge` starts
   * the merge (e.g. "npm test"). A non-zero exit aborts the merge.
   */
  preMerge?: string;
  /**
   * Shell command `fleet validate` runs inside an agent's worktree and records
   * per commit (e.g. "npm test"). When set, `fleet merge` requires the agent's
   * tip to have a passing record, running the command itself if the record is
   * missing or stale.
   */
  validate?: string;
  /**
   * Shared files that belong to no repository but that several agents write —
   * a machine-wide `CLAUDE.md`, an OSS queue, an editor settings file.
   * Worktrees isolate the repo and nothing else, so these are the overlaps
   * `fleet check` cannot otherwise see. `~` and repo-relative paths are
   * accepted; each entry is digested at spawn and compared at check time.
   */
  guardedPaths?: string[];
}

/**
 * Absolute location of a guarded-path entry: `~` expands to the home
 * directory, a relative entry resolves against the repo root, and an absolute
 * one is normalized. Pure, so the rules are testable without a filesystem.
 */
export function resolveGuardedPath(entry: string, repoRoot: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.resolve(path.join(os.homedir(), entry.slice(2)));
  }
  return path.resolve(repoRoot, entry);
}

export const CONFIG_FILE = '.fleetrc.json';
export const DEFAULT_WATCH_INTERVAL = 3;
export const DEFAULT_AUTO_CLEAN = false;

const VALID_KEYS =
  'defaultBase, watchInterval, autoClean, copyOnSpawn, postSpawn, preMerge, validate, guardedPaths';

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILE);
}

/** Read and validate `.fleetrc.json`. A missing file is fine; a broken one is not. */
export function readConfig(repoRoot: string): FleetConfig {
  const file = configPath(repoRoot);
  if (!existsSync(file)) {
    return {};
  }
  // Strip a UTF-8 BOM: Windows editors add one and JSON.parse rejects it.
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FleetError(
      `Config file is not valid JSON: ${file}\nFix the syntax or delete the file to fall back to defaults.`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FleetError(`Config file must contain a JSON object: ${file}`);
  }

  const config: FleetConfig = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    switch (key) {
      case '$schema':
        // Editor-only pointer to a JSON schema (shipped as schema/fleetrc.schema.json).
        if (typeof value !== 'string') {
          throw new FleetError(`"$schema" in ${CONFIG_FILE} must be a string (schema URL).`);
        }
        break;
      case 'defaultBase':
        if (typeof value !== 'string' || value.trim() === '') {
          throw new FleetError(`"defaultBase" in ${CONFIG_FILE} must be a non-empty string (branch name).`);
        }
        config.defaultBase = value;
        break;
      case 'watchInterval':
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          throw new FleetError(`"watchInterval" in ${CONFIG_FILE} must be a positive number of seconds.`);
        }
        config.watchInterval = value;
        break;
      case 'autoClean':
        if (typeof value !== 'boolean') {
          throw new FleetError(`"autoClean" in ${CONFIG_FILE} must be true or false.`);
        }
        config.autoClean = value;
        break;
      case 'copyOnSpawn': {
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
          throw new FleetError(
            `"copyOnSpawn" in ${CONFIG_FILE} must be an array of non-empty path strings.`,
          );
        }
        const entries = value as string[];
        for (const entry of entries) {
          if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
            throw new FleetError(
              `"copyOnSpawn" entry "${entry}" in ${CONFIG_FILE} must be a relative path inside the repository.`,
            );
          }
        }
        config.copyOnSpawn = entries;
        break;
      }
      case 'postSpawn':
        if (typeof value !== 'string' || value.trim() === '') {
          throw new FleetError(`"postSpawn" in ${CONFIG_FILE} must be a non-empty command string.`);
        }
        config.postSpawn = value;
        break;
      case 'preMerge':
        if (typeof value !== 'string' || value.trim() === '') {
          throw new FleetError(`"preMerge" in ${CONFIG_FILE} must be a non-empty command string.`);
        }
        config.preMerge = value;
        break;
      case 'validate':
        if (typeof value !== 'string' || value.trim() === '') {
          throw new FleetError(`"validate" in ${CONFIG_FILE} must be a non-empty command string.`);
        }
        config.validate = value;
        break;
      case 'guardedPaths':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
          throw new FleetError(
            `"guardedPaths" in ${CONFIG_FILE} must be an array of non-empty path strings.`,
          );
        }
        config.guardedPaths = value as string[];
        break;
      default:
        throw new FleetError(`Unknown key "${key}" in ${CONFIG_FILE}. Valid keys: ${VALID_KEYS}.`);
    }
  }
  return config;
}
