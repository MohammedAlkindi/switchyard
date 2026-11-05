# demo.tape — 30s demo of Switchyard's fleet CLI (spawn -> list -> check)
# Render from the repo root with the vhs-fleet image (built by Dockerfile.vhs):
#   docker build -f Dockerfile.vhs -t vhs-fleet .
#   docker run --rm -v "$PWD:/vhs" vhs-fleet demo.tape
# The demo runs in a throwaway git repo inside the container; this repo is untouched.
# Do NOT run this tape with a bare local vhs: the hidden setup below runs
# `git config --global`, which would overwrite your real git identity.
# The README embeds a GIF converted from the mp4 (conversion command in README.md).
#
# The scenario is built to exercise v0.2 merge-tree prediction, so both agents
# COMMIT their work — merge-tree cannot simulate uncommitted edits, and an
# uncommitted side would render the weaker "uncommitted edits" verdict instead.
# Two shared files, deliberately:
#   src/api/routes.ts — both rewrite the same line      -> will conflict (blocks)
#   src/config.ts     — edits 7 lines apart             -> merges cleanly (demoted)
# That contrast is the v0.2 story: sharing a file is not the same as conflicting.

Output assets/demo.mp4

Set Shell "bash"
Set Width 1920
Set Height 1080
Set FontSize 28
Set FontFamily "JetBrains Mono"
Set Padding 48
Set TypingSpeed 55ms
Set Theme { "name": "Tokyo Night", "background": "#1a1b26", "foreground": "#c0caf5", "cursor": "#c0caf5", "selection": "#28344a", "black": "#15161e", "red": "#f7768e", "green": "#9ece6a", "yellow": "#e0af68", "blue": "#7aa2f7", "magenta": "#bb9af7", "cyan": "#7dcfff", "white": "#a9b1d6", "brightBlack": "#414868", "brightRed": "#f7768e", "brightGreen": "#9ece6a", "brightYellow": "#e0af68", "brightBlue": "#7aa2f7", "brightMagenta": "#bb9af7", "brightCyan": "#7dcfff", "brightWhite": "#c0caf5" }

# ---- hidden: throwaway demo repo ----
Hide
Type@0ms `git config --global user.email demo@example.com && git config --global user.name demo && git config --global init.defaultBranch main && mkdir -p ~/demo-app/src/api && cd ~/demo-app && git init -q`
Enter
Sleep 1s
Type@0ms `echo 'export const routes = ["users"];' > src/api/routes.ts && echo 'export const config = {' > src/config.ts && echo '  name: "demo-app",' >> src/config.ts && echo '  port: 3000,' >> src/config.ts && echo '  host: "localhost",' >> src/config.ts && echo '  debug: false,' >> src/config.ts && echo '  retries: 3,' >> src/config.ts && echo '  timeout: 5000,' >> src/config.ts && echo '  verbose: false,' >> src/config.ts && echo '  region: "us-east-1",' >> src/config.ts && echo '};' >> src/config.ts && echo '# demo-app' > README.md && git add -A && git commit -qm init && clear`
Enter
Sleep 2s
Show

Sleep 1.5s

# ---- beat 1: isolate two agents ----
Type "# two AI agents, one repo, zero collisions"
Enter
Sleep 800ms
Type "fleet spawn claude"
Enter
Sleep 3s
Type "fleet spawn codex"
Enter
Sleep 3s

# ---- hidden: both agents do their work and commit ----
# claude edits config.ts line 2, codex edits line 9 — far enough apart to
# auto-merge. Both rewrite the single line of routes.ts — a real conflict.
Hide
Type@0ms `cd .fleet/worktrees/claude && echo 'export const routes = ["users", "profiles"];' > src/api/routes.ts && sed -i 's/demo-app/demo-api/' src/config.ts && git add -A && git commit -qm 'feat: profile routes' && cd ~/demo-app/.fleet/worktrees/codex && echo 'export const routes = ["users", "billing"];' > src/api/routes.ts && sed -i 's/us-east-1/eu-west-1/' src/config.ts && git add -A && git commit -qm 'feat: billing routes' && cd ~/demo-app && clear`
Enter
Sleep 2s
Show

Sleep 800ms

# ---- beat 2: one view of the whole fleet ----
Type "fleet list"
Enter
Sleep 6.5s

# ---- beat 3: payoff — the real conflict blocks, the clean overlap doesn't ----
Type "fleet check"
Enter
Sleep 7.5s
Type "# sharing a file isn't a conflict — only the real one blocks"
Enter
Sleep 7s
