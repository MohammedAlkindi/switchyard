# Deployment

Switchyard publishes to npm as [`@switchyardhq/switchyard`](https://www.npmjs.com/package/@switchyardhq/switchyard) — unscoped `switchyard` is taken, but the `@switchyardhq` scope makes the project's own name available, so the package name matches the project. The installed binary is `fleet`.

## Before any release

Every release requires all CI checks green on `main` — lint, typecheck, build, and tests (see `.github/workflows/ci.yml`). Locally that's:

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

`prepublishOnly` re-runs lint, typecheck, and tests automatically, so `npm publish` refuses to ship a broken build — but don't rely on it as your first line of defense.

## Testing a local build before publishing

```sh
npm run build
npm link                 # installs the local build globally as `fleet`

mkdir /tmp/fleet-scratch && cd /tmp/fleet-scratch
git init -b main && git commit --allow-empty -m "init"
fleet spawn test-agent   # run through spawn → list → check → remove → clean
cd - && npm unlink -g @switchyardhq/switchyard
```

Walk the full command loop in the scratch repo, not just `--help` — the failure modes worth catching are git-behavior ones.

## Publishing a new version

First, move the `Unreleased` entries in [CHANGELOG.md](../CHANGELOG.md) under a
new version heading (dated, matching the version you're about to publish) and
commit that — the tag `npm version` creates should include the changelog.

```sh
npm version patch        # or: minor | major
git push origin main --follow-tags
```

`npm version` bumps `package.json`, commits, and tags in one step — don't edit the version by hand.

Pushing the `v*` tag triggers the release workflow (`.github/workflows/release.yml`): it re-runs lint, typecheck, and the test suite, verifies the tag matches `package.json`, and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements). It authenticates with the `NPM_TOKEN` repository secret — a granular npm automation token with publish rights on `@switchyardhq/switchyard`; rotate it from npmjs.com → Access Tokens if it leaks or expires. A manual `npm publish` from a clean checkout still works as a fallback (`prepublishOnly` runs the same checks), but the workflow is the normal path — it can't publish uncommitted work.

Semver conventions for this package:

- **patch** — bug fixes, error-message improvements, doc-only changes shipped in the package.
- **minor** — new commands or new flags on existing commands, backwards-compatible.
- **major** — anything that breaks existing usage: renamed/removed commands or flags, changed exit-code semantics, or a `state.json` schema change without a migration path (`version` field in the schema exists for this).

Only the `dist/` output ships to npm (`files` in `package.json`); `prepare` rebuilds it on publish, so there is no manual build step to forget.

## After the first publish

The README's npm version/downloads badges are live and point at `@switchyardhq/switchyard`. shields.io renders "package not found" for them until the package's first publish — expected before the release, a problem after it. Once the publish lands, reload the README and confirm both badges resolve.
