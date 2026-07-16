# demo.tape — 30s demo of Switchyard's fleet CLI (spawn -> list -> check)
# Render from the repo root with the vhs-fleet image (vhs + node + fleet baked in):
#   docker run --rm -v "$PWD:/vhs" vhs-fleet demo.tape
# The demo runs in a throwaway git repo inside the container; this repo is untouched.
# Do NOT run this tape with a bare local vhs: the hidden setup below runs
# `git config --global`, which would overwrite your real git identity.
# The README embeds a GIF converted from the mp4 (conversion command in README.md).

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
Type@0ms "git config --global user.email demo@example.com && git config --global user.name demo && git config --global init.defaultBranch main && mkdir -p ~/demo-app/src/api && cd ~/demo-app && git init -q && echo 'export const routes = [];' > src/api/routes.ts && echo '# demo-app' > README.md && git add -A && git commit -qm init && clear"
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

# ---- hidden: the agents do their work (claude commits, codex leaves edits) ----
Hide
Type@0ms `cd .fleet/worktrees/claude && echo 'export const routes = ["users"];' > src/api/routes.ts && echo 'export const auth = true;' > src/api/auth.ts && git add -A && git commit -qm 'feat: user routes' && cd ~/demo-app/.fleet/worktrees/codex && echo 'export const routes = ["billing"];' > src/api/routes.ts && echo 'export const billing = true;' > src/billing.ts && cd ~/demo-app && clear`
Enter
Sleep 2s
Show

Sleep 800ms

# ---- beat 2: one view of the whole fleet ----
Type "fleet list"
Enter
Sleep 6.5s

# ---- beat 3: payoff — collision caught before merge ----
Type "fleet check"
Enter
Sleep 6s
Type "# collision caught before anyone merged"
Enter
Sleep 7s
