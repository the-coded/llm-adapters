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

Releases go to npm through a GitHub Release and the `publish.yml` workflow, with
npm Trusted Publishing. The full process, the one-time setup and what to do when
a release fails are in [RELEASING.md](RELEASING.md).

## Commits and licence

Conventional Commits. Commit messages carry no attribution trailers of any kind.

Contributions are accepted under the MIT licence, the same terms as the rest of
the project.
