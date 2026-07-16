# Security Policy

## Supported versions

Switchyard is pre-1.0. Only the latest published version of
[`git-fleet`](https://www.npmjs.com/package/git-fleet) receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems. Instead, either:

- use GitHub's private vulnerability reporting on this repository
  ([Security → Report a vulnerability](https://github.com/MohammedAlkindi/Switchyard/security/advisories/new)), or
- email alkndymhmd692@gmail.com with `git-fleet security` in the subject.

Include the `git-fleet` version, your OS, a reproduction, and the impact as you
understand it. This is a solo-maintained project: you'll get an acknowledgment
within a few days, and confirmed issues ship as a patch release. You'll be
credited in the release notes unless you ask not to be.

## Scope

Switchyard shells out to `git` against repositories on the user's machine, so
the reports that matter most are:

- command or argument injection through agent names, branch names, file paths,
  or the contents of `.fleetrc.json` / `.fleet/state.json`;
- Switchyard writing or deleting files outside `.fleet/` and the repository it
  manages, without an explicit flag asking for it;
- any way a crafted repository (state file, worktree layout, or config) can
  make Switchyard execute commands the user didn't intend — note that
  `.fleetrc.json` hooks (`postSpawn`, `preMerge`) run shell commands by
  design; the trust boundary is the repository the user chose to work in.

A missed collision in `fleet check` is a correctness bug, not a vulnerability —
please file a regular issue for those.
