# Releasing

How a version of `@the-coded/llm-adapters` reaches npm. The short version:
bump the version, merge, publish a GitHub Release tagged `vX.Y.Z`, and the
`publish.yml` workflow does the rest.

## How it works

Publishing a GitHub Release runs `.github/workflows/publish.yml`. Pushing a tag
alone publishes nothing: a person publishing the release is the gate.

Before anything reaches the registry, the job:

1. checks that the release tag is `v` plus the `package.json` version and that
   `package.json` is not marked `private` (`scripts/check-release.mjs`);
2. runs the CI checks on Node 24: `npm ci`, typecheck of the package and the
   examples, build, the test suite and the tarball check
   (`scripts/verify-pack.mjs`). Bun and Node 22 are covered by CI on the pull
   request, not again at release time;
3. runs `npm publish --provenance`.

It authenticates with npm Trusted Publishing: there is no `NPM_TOKEN` secret.
npm exchanges the workflow's OIDC token for a short-lived credential and attaches
provenance, so every version on npm links back to the commit and workflow run
that built it. Trusted Publishing needs npm 11.5.1 or newer, which the job
installs and asserts. Two releases published close together queue instead of
racing each other to the registry.

## Releasing a new version

1. **Pick the version** by [Semantic Versioning](https://semver.org/). While the
   package is `0.x`, a breaking change bumps the minor (`0.1.0` → `0.2.0`) and
   everything else bumps the patch (`0.1.0` → `0.1.1`).
2. **Bump it on a branch**, in the same commit as the changelog:
   - `npm version <x.y.z> --no-git-tag-version`, which updates `package.json`
     and `package-lock.json` without creating a tag;
   - a new `## [x.y.z]` section at the top of `CHANGELOG.md`, in
     [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format
     (Added, Changed, Fixed, Removed).
   - Commit as `chore(release): x.y.z`.
3. **Check locally** before opening the pull request:

   ```sh
   npm ci
   npm run typecheck
   npm test
   npm run verify:pack
   ```

4. **Merge the pull request** into `main` once CI is green.
5. **Publish the GitHub Release** from `main`: tag `vX.Y.Z` (it must match
   `package.json`), title `vX.Y.Z`, and the changelog section as the notes.
6. **Watch the run** under Actions → `publish`. When it is green, check the
   version on npm: `npm view @the-coded/llm-adapters version`. The registry can
   take a few minutes to show a new version.

## Pre-releases (alpha, beta, rc)

A pre-release never becomes `latest`: whoever runs `npm install
@the-coded/llm-adapters` keeps getting the last stable version.

1. Version it with a pre-release suffix, by convention `x.y.z-alpha.N`,
   `x.y.z-beta.N` or `x.y.z-rc.N` (for example `0.2.0-beta.1`), bumped and
   changelogged like any other version. Any semver pre-release suffix counts
   (the part after `-`, before any `+build` metadata), not only these three.
2. Publish the GitHub Release with the tag `vx.y.z-beta.N` and the
   **"Set as a pre-release"** box checked.
3. The workflow publishes it under the `next` dist-tag. Install it with
   `npm install @the-coded/llm-adapters@next`.
4. When it is good, release the final `x.y.z` the normal way; it becomes
   `latest`.

The release is refused before anything is built when the two signals disagree:
a version with a pre-release suffix on a Release not marked as pre-release, or
a Release marked as pre-release on a plain `x.y.z` version. npm 11 itself
refuses to publish a pre-release version without an explicit `--tag`, so this
is the workflow choosing `next` on purpose rather than npm defaulting.

## One-time setup

`publishConfig.access` is `public` in `package.json` because a scoped package is
restricted by default, and a first publish without it fails. Nothing in the
repository blocks a publish: a plain `npm publish` from a clean, built checkout
publishes for real.

| Step | Where | Status |
| --- | --- | --- |
| `the-coded` organisation on npmjs.com, owning the `@the-coded` scope | npmjs.com | done |
| First version published by hand (npm only allows a trusted publisher on a package that already exists) | local, logged in with 2FA | done: `0.1.0`, 2026-10-19 |
| Trusted publisher: GitHub Actions, organisation `the-coded`, repository `llm-adapters`, workflow `publish.yml`, environment `npm`, with direct `npm publish` allowed | npmjs.com → package → Settings | done 2026-10-19; **valid** since the first workflow publish (`0.1.1-beta.0`, 2026-10-19) |
| GitHub environment named `npm` | GitHub → repository → Settings → Environments | done 2026-10-19 |
| Tag and GitHub Release `v0.1.0` on the commit that was published (`5d7edf8`) | GitHub | done 2026-10-19 (the publish run it triggered was cancelled; see below) |

npm does not validate the trusted-publisher entry when it is saved: a mistake
shows up as `ENEEDAUTH` on the next release. Required reviewers can be added to
the `npm` environment at any time, without editing the workflow, if a release
should need a second approval.

**Releasing a version that is already on npm.** Publishing a GitHub Release
always runs the workflow, and for a version already on npm it would fail at
`npm publish`, because a published version can never be reused. To add a
Release after the fact (as done for `v0.1.0`), publish it and cancel the
`publish` run it triggers: `gh run cancel <run id>`.

**The `0.0.0-stage` placeholder.** When a package that does not exist yet is
staged with `npm stage publish`, npm publishes a public placeholder version,
`0.0.0-stage` (see npm's
[staged publishing docs](https://docs.npmjs.com/staged-publishing/)); on the
package page its README reads "Temporary Holding Version". This package got one
on its first publish and keeps it: it is not `latest` or `next`, so nobody
installs it by accident. Removing it would take `npm unpublish
@the-coded/llm-adapters@0.0.0-stage`, after `npm stage list` / `npm stage reject
<stage-id>` for anything still pending (npm 11.15 or newer;
[command reference](https://docs.npmjs.com/cli/v11/commands/npm-stage/),
[unpublish policy](https://docs.npmjs.com/policies/unpublish/)).

## When something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `check-release: release tag ... does not match` | The tag and `package.json` disagree | Delete the Release and its tag, bump or retag, publish again |
| `check-release: package.json sets "private"` | Someone added `"private"` back | Remove the field in a commit, then release again |
| `check-release: version ... is a pre-release but the GitHub Release is not marked as one` | Suffix in the version, "Set as a pre-release" unchecked | Delete the Release and its tag, then publish it again with the box checked. Re-running the job does not help: it reuses the flag from the original event |
| `check-release: the GitHub Release is marked as a pre-release but version ... has no pre-release suffix` | Box checked on a stable version | Delete the Release and its tag, then publish it again unchecked (or bump to a suffixed version) |
| `ENEEDAUTH` at `npm publish` | Trusted publisher missing or mistyped | Fix the entry on npmjs.com (names are exact), re-run the job |
| `EPUBLISHCONFLICT` / "cannot publish over" | That version already exists on npm | Bump to the next version; versions are never reused |
| A broken version is already out | — | Publish a fix as the next patch, and mark the bad one with `npm deprecate @the-coded/llm-adapters@x.y.z "<reason>"`. Unpublishing is restricted (generally within 72 hours, and after that only under narrow conditions) and breaks anyone who installed it; prefer deprecating. |

## Publishing by hand

Only for the first version, or if the workflow is unavailable. From a clean
checkout of the release commit, logged in to npm with 2FA:

```sh
npm ci && npm run typecheck && npm test && npm run verify:pack
npm publish
```

`npm publish` does not build: `npm test` and `npm run verify:pack` leave a fresh
`dist/`, which is what gets packed. A version published by hand carries no
provenance.
