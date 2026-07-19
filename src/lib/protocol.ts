import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FleetError } from './errors.js';

/**
 * Delimiters around the block `fleet init` manages inside AGENTS.md. Everything
 * between them is package-owned and replaced on every init; everything outside
 * is the user's and never touched. HTML comments because they render invisibly
 * in every markdown viewer.
 */
export const BLOCK_BEGIN = '<!-- switchyard:begin -->';
export const BLOCK_END = '<!-- switchyard:end -->';

/** Where `fleet init` installs the Claude Code skill, repo-root-relative. */
export const SKILL_INSTALL_PATH = '.claude/skills/switchyard/SKILL.md';

/** The agent-neutral protocol block written into AGENTS.md. */
export const AGENTS_MD_FILE = 'AGENTS.md';

/**
 * Resolve the SKILL.md shipped inside this package.
 *
 * The relative hop is the same compiled (`dist/lib/protocol.js`) and from
 * source under vitest (`src/lib/protocol.ts`): both sit two levels below the
 * package root, so neither needs a build-time constant.
 */
export function packagedSkillPath(): string {
  return fileURLToPath(new URL('../../skills/switchyard/SKILL.md', import.meta.url));
}

export function readPackagedSkill(): string {
  const file = packagedSkillPath();
  if (!existsSync(file)) {
    throw new FleetError(
      `Could not find the packaged skill at ${file}.\n` +
        'This usually means the install is incomplete — reinstall @switchyardhq/switchyard.',
    );
  }
  return readFileSync(file, 'utf8');
}

/**
 * The short protocol summary for AGENTS.md.
 *
 * Deliberately not generated from SKILL.md. The two have different audiences —
 * a Claude agent loading a full skill on demand, versus any agent that reads
 * AGENTS.md up front and needs the short version — and auto-summarizing one
 * into the other produces a worse block than writing it directly.
 */
export const AGENTS_BLOCK = `${BLOCK_BEGIN}
## Working in a Switchyard fleet

This repository uses Switchyard so that several AI agents can work in it
without overwriting each other. Each agent gets its own git worktree and
branch (\`fleet/<name>\`).

1. **Find your worktree before editing anything.** Run \`fleet list\` and match
   your own agent name. Work inside that directory — never in the main
   checkout. Editing the main checkout while other agents hold worktrees off
   it is the exact failure this tool exists to prevent.
2. **Run \`fleet check\` before you start on a file, not just before merging.**
   Checking only at merge time finds the collision after both agents have
   already done the work. A \`conflicts\` verdict means stop and coordinate;
   \`uncommitted\` means another agent has unsaved work there that merge
   simulation could not see.
3. **Do not create a worktree or branch yourself.** If \`fleet list\` has no
   entry for you, ask for \`fleet spawn <your-name>\` instead of running
   \`git worktree add\` — an untracked worktree is invisible to every other
   agent's \`fleet check\`, which is precisely the uncoordinated state
   Switchyard prevents.
4. **Provisioning and merging are human actions.** Ask for \`fleet merge\`,
   \`fleet sync\`, or \`fleet pr\` by name. There is no agent-facing tool for
   them, by design.

This block is managed by \`fleet init\`; edits inside it are overwritten.
Full protocol: \`${SKILL_INSTALL_PATH}\`.
${BLOCK_END}`;

/**
 * Insert `block` into `existing`, replacing a previously written block when the
 * markers are already present and appending when they are not.
 *
 * Pure, so the placement rules are testable without touching a filesystem.
 * `block` carries its own markers.
 */
export function upsertMarkedBlock(existing: string, block: string): string {
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);

  if (begin === -1 && end === -1) {
    if (existing.trim() === '') return `${block}\n`;
    // Leave exactly one blank line between the user's content and the block.
    const gap = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${gap}${block}\n`;
  }

  // A half-present or inverted pair means someone hand-edited the markers.
  // Rewriting on a guess could silently eat their content, so refuse instead.
  if (begin === -1 || end === -1 || end < begin) {
    throw new FleetError(
      `The Switchyard block in ${AGENTS_MD_FILE} has broken markers.\n` +
        `Expected "${BLOCK_BEGIN}" followed by "${BLOCK_END}".\n` +
        'Fix or delete the markers by hand, then re-run `fleet init`.',
    );
  }

  return `${existing.slice(0, begin)}${block}${existing.slice(end + BLOCK_END.length)}`;
}
