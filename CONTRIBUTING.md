# Contributing

## Getting set up

```sh
npm install
npm run build      # tsc to dist/, plus the fixture copy the suite needs
npm test           # builds, then node --test over the compiled output
npm run test:bun   # the same compiled output under Bun
npm run typecheck  # tsc --noEmit
npm run verify:pack # asserts what the published tarball would contain
```

Node 22 or newer, or Bun. There are no runtime dependencies and only two
dev ones: TypeScript and `@types/node`.

## How the suite is arranged

Tests live beside the source as `src/**/*.test.ts` and are compiled by the same
`tsc` run as the library, so they are type-checked and then executed as plain
JavaScript by `node --test` and by `bun test`. No runner, no flags, no
transform. The published tarball excludes them.

That layout is why the entry point emits at `dist/index.js` rather than
`dist/src/index.js`: a `test/` directory at the root would force `rootDir: "."`
and push the entry point down a level.

## What is covered, and what cannot be

Covered: the CLI usage extractor and output parser against a real sanitised
`claude --print --output-format json` sample rather than a mock; the factory's
provider mapping, every documented refusal, and inherited-prototype keys; both
HTTP adapters against a stubbed `fetch` for request shape, streamed decoding,
mid-stream error events, non-ok responses and usage reporting; `listModels` for
the three adapters that implement it, including a missing binary; the opencode
step-usage selection rule against every shape that broke a weaker version of it;
the redactor; the config helper's permission, precedence and refusal behaviour;
and two repository guards.

**Not covered: `stream()` and `complete()` on `claude-code` and `opencode`.**
Both spawn a vendor CLI, so exercising them needs that CLI installed and
authenticated, which a test suite cannot assume. Where a spawn *can* be
simulated it is — several tests stand up a small `#!/bin/sh` stub binary and
drive the real spawn path through it. Those are POSIX-only by construction; a
Windows runner would need a `.cmd` twin.

## Conventions that are not obvious

**Everything written here is English** — code, comments, documentation, planning
notes and string literals. A test enforces it, and it reads whole files rather
than only comments, because in a fixture the language is data.

**Unknown is `null`, never `0`.** It holds for every numeric field a provider
might not report, and for the model name. Zero and unknown are the same number
inside a sum and opposite facts inside a spending decision. An adapter with
nothing to report does not invoke `onUsage` at all.

**A declared limit is fine; an undeclared one is a defect.** Where something is
deliberately not handled, the comment at that spot says so and says why. A
guard whose documentation overstates its reach is worse than no guard, because
it stops anyone from looking.

**A check that cannot fail is not a check.** New guards are expected to be seen
failing before they are trusted, and a premise assertion — that the walk found
files, that `dist/` is non-empty — belongs in the test that depends on it.

## Publishing

The package goes to the public npm registry, under the `@the-coded` scope owned
by the `the-coded` organisation on npmjs.com. `publishConfig.access` is `public`
because a scoped package is restricted by default, and a first publish without
it fails. Nothing in the repository blocks a publish: a plain `npm publish` from
a clean checkout publishes for real.

### The release flow

Publishing a GitHub Release runs `.github/workflows/publish.yml`. Before it
publishes, the job checks that the release tag is `v` plus the `package.json`
version and that `package.json` is not marked `private`
(`scripts/check-release.mjs`), then
runs the same gates as CI: install, typecheck of the package and the examples,
build, the suite and the tarball check. Pushing a tag alone publishes nothing.

The job authenticates with npm Trusted Publishing: no `NPM_TOKEN` secret exists,
npm exchanges the workflow's OIDC token for a short-lived credential, and
provenance is attached to every version. It needs npm 11.5.1 or newer, which the
job installs and asserts.

### One-time setup, outside the repository

- The `the-coded` organisation on npmjs.com, which owns the `@the-coded` scope.
- **The first version is published by hand.** npm only lets a trusted publisher
  be configured on a package that already exists, so the workflow cannot publish
  version one: run `npm publish` from a clean checkout of the release commit,
  logged in to npm with 2FA.
- Then, in the package's settings on npmjs.com, add a trusted publisher: GitHub
  Actions, organisation `the-coded`, repository `llm-adapters`, workflow
  `publish.yml`, environment `npm`, with direct `npm publish` allowed. npm does
  not validate this entry when it is saved; a mistake surfaces as `ENEEDAUTH` on
  the next release.
- A GitHub environment named `npm` in the repository settings. Required
  reviewers can be added to it at any time without editing the workflow.

Every later version goes out through a GitHub Release.

## Commits and licence

Conventional Commits. Commit messages carry no attribution trailers of any kind.

Contributions are accepted under the MIT licence, the same terms as the rest of
the project.
