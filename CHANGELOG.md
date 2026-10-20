# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Added

- `shutdown({ graceMs })`: stops every process the package started (the CLIs
  of in-flight calls and the shared `opencode serve`), escalating to SIGKILL
  after the grace period. Idempotent, never rejects. A host that traps
  SIGINT/SIGTERM calls it; the package still installs no handlers.
- `StreamOptions.maxTokens` (also on `complete()`): sent by the `anthropic`
  and `openai-compatible` adapters, ignored by the CLI adapters.
- `LLMStreamChunk.status`: the provider's HTTP status on errors that came from
  an HTTP response.

### Fixed

- A host that exited (normally or by signal) left `opencode serve` running
  and holding its port; it can now be stopped with `shutdown()`.
- An `opencode` call in progress when its server died by a signal kept
  waiting until the 30 s boot timeout instead of failing at once.

## [0.1.1]

### Added

- Pre-release publishing: a version with a pre-release suffix, on a GitHub
  Release marked as pre-release, is published under the `next` dist-tag and
  never becomes `latest`.
- `RELEASING.md`, with the release process.

### Changed

- README with new artwork, tagline, and npm and CI badges.
- CI and publish workflows on `actions/checkout` and `actions/setup-node` v7.

## [0.1.1-beta.0]

### Added

- Pre-release publishing: a version with a pre-release suffix, on a GitHub
  Release marked as pre-release, is published under the `next` dist-tag and
  never becomes `latest`.
- `RELEASING.md`, with the release process.

## [0.1.0]

First release.
