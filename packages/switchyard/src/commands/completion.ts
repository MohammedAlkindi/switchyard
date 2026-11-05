import { FleetError } from '../lib/errors.js';
import { getMainRepoRoot } from '../lib/git.js';
import { readState } from '../lib/state.js';

export interface CompletionOptions {
  cwd?: string;
}

const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

/** command name -> short description (kept apostrophe-free for shell quoting). */
const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['init', 'set the repo up for the fleet workflow'],
  ['spawn', 'create an isolated worktree + branch for an agent'],
  ['list', 'show all active agents'],
  ['status', 'detailed view of one agent'],
  ['check', 'flag files touched by more than one agent'],
  ['diff', 'diff an agent branch against its base'],
  ['sync', 'catch an agent branch up with its base'],
  ['validate', 'run the validate command in an agent worktree and record it'],
  ['exec', 'run a command inside an agent worktree'],
  ['merge', 'merge an agent branch into the current branch and clean up'],
  ['undo', 'roll back the last fleet merge'],
  ['pr', 'push an agent branch and open a pull request via gh'],
  ['remove', 'remove an agent worktree'],
  ['clean', 'remove fully merged agents'],
  ['watch', 'live-updating agent table'],
  ['dashboard', 'live pane of agents, validation, and collisions'],
  ['doctor', 'diagnose and repair state drift'],
  ['completion', 'output a shell completion script'],
];

/** Commands whose first argument is an agent name. */
const AGENT_COMMANDS = ['status', 'diff', 'sync', 'validate', 'exec', 'merge', 'pr', 'remove'];

const SNAPSHOT_NOTE =
  'Agent names below are a snapshot of .fleet/state.json at generation time,\n' +
  '# not dynamic — re-run `fleet completion <shell>` after spawning or removing\n' +
  '# agents to refresh them.';

/**
 * Print a completion script for the given shell, covering command names and
 * the agent names currently registered in `.fleet/state.json`.
 */
export async function completion(shell: string, options: CompletionOptions = {}): Promise<string> {
  if (!(SHELLS as readonly string[]).includes(shell)) {
    throw new FleetError(`Unsupported shell "${shell}". Supported: ${SHELLS.join(', ')}.`);
  }

  // Outside a repo (or with no agents) the script still works; the agent-name
  // list is just empty.
  let agents: string[] = [];
  try {
    const repoRoot = await getMainRepoRoot(options.cwd ?? process.cwd());
    agents = Object.keys(readState(repoRoot).agents).sort();
  } catch {
    agents = [];
  }

  let script: string;
  switch (shell as Shell) {
    case 'bash':
      script = bashScript(agents);
      break;
    case 'zsh':
      script = zshScript(agents);
      break;
    case 'fish':
      script = fishScript(agents);
      break;
  }

  console.log(script);
  return script;
}

function bashScript(agents: string[]): string {
  const commands = COMMANDS.map(([name]) => name).join(' ');
  return `# fleet completion (bash) — source this file or add to ~/.bashrc:
#   eval "$(fleet completion bash)"
# ${SNAPSHOT_NOTE}
_fleet_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="${commands}"
  local agents="${agents.join(' ')}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi
  case "$prev" in
    ${AGENT_COMMANDS.join('|')})
      COMPREPLY=( $(compgen -W "$agents" -- "$cur") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "${SHELLS.join(' ')}" -- "$cur") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac
}
complete -F _fleet_completions fleet`;
}

function zshScript(agents: string[]): string {
  const commandLines = COMMANDS.map(([name, desc]) => `    '${name}:${desc}'`).join('\n');
  return `#compdef fleet
# fleet completion (zsh) — write to a file on your $fpath, e.g.:
#   fleet completion zsh > ~/.zsh/completions/_fleet
# ${SNAPSHOT_NOTE}
_fleet() {
  local -a commands agents
  commands=(
${commandLines}
  )
  agents=(${agents.join(' ')})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case "\${words[2]}" in
    ${AGENT_COMMANDS.join('|')})
      _describe 'agent' agents
      ;;
    completion)
      _values 'shell' ${SHELLS.join(' ')}
      ;;
  esac
}
_fleet "$@"`;
}

function fishScript(agents: string[]): string {
  const commandLines = COMMANDS.map(
    ([name, desc]) =>
      `complete -c fleet -n '__fish_use_subcommand' -a ${name} -d '${desc}'`,
  ).join('\n');
  const agentCondition = `__fish_seen_subcommand_from ${AGENT_COMMANDS.join(' ')}`;
  return `# fleet completion (fish) — write to ~/.config/fish/completions/fleet.fish:
#   fleet completion fish > ~/.config/fish/completions/fleet.fish
# ${SNAPSHOT_NOTE}
complete -c fleet -f
${commandLines}
complete -c fleet -n '${agentCondition}' -a '${agents.join(' ')}'
complete -c fleet -n '__fish_seen_subcommand_from completion' -a '${SHELLS.join(' ')}'`;
}
