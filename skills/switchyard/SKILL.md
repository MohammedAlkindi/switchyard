---
name: switchyard
description: Use when working in a repo where multiple AI agents share one codebase — establishing which worktree is yours, checking for collisions before editing a file, and reading fleet state before asking for a merge.
---

# Working inside a Switchyard fleet

Switchyard gives each agent its own git worktree and branch (`fleet/<name>`) so
several agents can work in one repository without overwriting each other. This
skill is how you participate in that arrangement correctly.

The MCP tools below are read-only. Everything that changes the fleet is a human
action in this release — see [Provisioning and merging](#provisioning-and-merging-are-human-actions).

## 1. Establish your position first

Call `fleet_list` before anything else. It returns every active agent with its
branch, base branch, worktree path, ahead/behind counts, uncommitted file count,
and last activity.

Read it to answer two questions:

- **Does a fleet exist here at all?** An empty list means no agent worktrees are
  in play; work normally.
- **Which worktree is mine?** Match your own agent name. If nothing matches, you
  have not been provisioned — ask for one rather than improvising.

## 2. Work inside your own worktree, never the main checkout

Everything Switchyard guarantees rests on this. The worktree path from
`fleet_list` is where your edits belong. Editing the main checkout while other
agents hold worktrees off it is the exact failure the tool exists to prevent.

If you are unsure which directory you are in, check before you write.

## 3. Check before you edit, not just before you merge

Call `fleet_check` **before you start on a file**, and again **before asking for
a merge**. Checking only at merge time finds the collision after both agents
have already done the work.

By default each shared file is run through a merge simulation, so a file two
agents touched is only reported as a collision when it genuinely is one. Read
the `verdict` on each entry:

| Verdict | Meaning | What to do |
| --- | --- | --- |
| `conflicts` | The two branches would actually conflict in this file. | **Stop.** Coordinate before touching it — pick a different file, or ask for the other agent's work to land first. |
| `uncommitted` | Another agent has unsaved work in this file that merge simulation could not see. | Treat as blocked. Their edits are invisible to git until committed, so the simulation is not evidence of safety. |

Other fields worth reading:

- `cleanMerges` — shared files whose committed changes merge cleanly. Awareness,
  not a blocker.
- `disjoint` (with `lines: true`) — same file, non-overlapping line ranges.
- `prediction` — `merge-tree` when simulation ran, `files` when it fell back to
  flagging any shared file (git older than 2.38). Under `files`, an entry is a
  weaker signal: it means "both touched this", not "this would conflict".

Call `fleet_status` with an agent name when you need the detail behind a
listing: its uncommitted files and a diffstat of its committed work vs its base.

## 4. Respect the mutation lock

`fleet_lock_status` reports whether a fleet command is mid-flight:

- `live` — a human is mid-spawn, mid-merge, or mid-clean. **Wait and retry.** Do
  not work around it; the state you would read is being rewritten underneath you.
- `stale` — the holding process died. `fleet doctor --fix` clears it. Say so
  rather than proceeding on state that may be inconsistent.
- `none` — the repository is idle.

## Provisioning and merging are human actions

There is no tool here to spawn an agent, merge a branch, remove a worktree, or
clean up. That is deliberate, not an oversight — this release lets agents
observe the fleet, not change it.

**Do not create a worktree or branch yourself.** Running `git worktree add`
because no spawn tool exists produces precisely the uncoordinated state
Switchyard prevents: a worktree nothing tracks, invisible to every other agent's
`fleet_check`.

When you need one of these, ask for it by name:

| You need | Ask the human to run |
| --- | --- |
| A worktree of your own | `fleet spawn <your-name>` |
| Your work merged | `fleet merge <your-name>` |
| Your base branch caught up | `fleet sync <your-name>` |
| A pull request | `fleet pr <your-name>` |
| State repaired after manual git surgery | `fleet doctor --fix` |

## Typical session

1. `fleet_list` — find your worktree, see who else is here.
2. `cd` into your worktree.
3. `fleet_check` — before opening the files you plan to edit.
4. Do the work, committing to your `fleet/<name>` branch as you go.
5. `fleet_check` again — confirm nothing collided while you worked.
6. Ask for `fleet merge <your-name>`, reporting anything `fleet_check` flagged.
