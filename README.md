<div align="center">
<!-- Absolute on purpose. `assets/` is not in the tarball, so a relative path
     renders as a broken image on the npm page; this URL shows the logo there
     too. -->
<img src="https://raw.githubusercontent.com/the-coded/llm-adapters/main/assets/llm-adapters-emblem.jpg" alt="llm-adapters — one interface to rule them all" width="40%" />

# @the-coded/llm-adapters

**One interface to rule them all.**

Every way an application talks to an LLM — API keys and local CLIs alike —
behind a single TypeScript contract.

[![npm](https://img.shields.io/npm/v/@the-coded/llm-adapters.svg)](https://www.npmjs.com/package/@the-coded/llm-adapters)
[![CI](https://github.com/the-coded/llm-adapters/actions/workflows/ci.yml/badge.svg)](https://github.com/the-coded/llm-adapters/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](#runtimes)
[![Bun](https://img.shields.io/badge/bun-supported-black.svg)](#runtimes)

</div>

An application that talks to an LLM ends up talking to two very different kinds
of thing. One is an HTTP API behind a key you pay for. The other is a CLI the
developer already has, already logged in, already paid for through a
subscription — and reaching it means spawning a process, resolving a binary,
building a minimal environment, and parsing a stream of JSON events.

Those have almost nothing in common, so applications grow two code paths and a
branch at every call site. `@the-coded/llm-adapters` collapses them into one
`LLMAdapter` contract: the same calls whether the tokens come from
Anthropic's API, any OpenAI-protocol gateway, the `claude` CLI, or an
`opencode` server. Swapping providers is a configuration change — one contract to bind them all.

## Features

- **Zero runtime dependencies.** The HTTP adapters use the platform's `fetch`;
  the CLI adapters use `node:child_process`. Nothing else is installed.
- **One contract over two mechanisms.** An HTTP API behind a key and a local CLI
  the developer already pays for, behind the same calls.
- **Streaming and non-streaming**, with `AbortSignal` honoured end to end so a
  client disconnect kills the spawned process or the in-flight request.
- **Token and cost reporting with provenance.** Unknown is `null` and never `0`,
  which is a contract rather than a convention.
- **Model discovery asked of the provider**, optional per adapter so a caller
  feature-detects instead of catching.
- **TypeScript-first**, shipped as compiled JavaScript plus declarations.
- **Node and Bun**, tested on both against the same compiled output.

## Install

```sh
npm install @the-coded/llm-adapters
```

Node 22 or newer, or Bun. Zero runtime dependencies: the
HTTP adapters use the platform's `fetch`, the CLI adapters use
`node:child_process`.

## Quick start

```ts
import { getLLMAdapter } from "@the-coded/llm-adapters";
import type { LLMMessage } from "@the-coded/llm-adapters";

// No API key: this spawns the `claude` CLI and uses your `claude login`
// session. Install it with `npm install -g @anthropic-ai/claude-code`.
const adapter = getLLMAdapter({ provider: "claude-code" });

const messages: LLMMessage[] = [{ role: "user", content: "Name three primes." }];

for await (const chunk of adapter.stream("Be terse.", messages)) {
  // Every adapter yields the same four chunk types, whatever is behind it.
  if (chunk.type === "text") process.stdout.write(chunk.text ?? "");
  if (chunk.type === "error") throw new Error(chunk.error);
}
```

With an API key instead, nothing else in your code changes:

```ts
import { getLLMAdapter } from "@the-coded/llm-adapters";

const anthropic = getLLMAdapter({
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY,   // required for this provider
  model: "claude-opus-5",                  // optional; falls back to the default
});

// Any OpenAI-protocol endpoint — OpenAI, OpenRouter, a local gateway.
const gateway = getLLMAdapter({
  provider: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1", // required for this provider
  apiKey: process.env.OPENROUTER_API_KEY,
});

const answer = await anthropic.complete("Be terse.", [
  { role: "user", content: "Name three primes." },
]);
```

## Providers

<div align="center">
<!-- Absolute for the same reason as the logo: assets/ is not in the tarball. -->
<img src="https://raw.githubusercontent.com/the-coded/llm-adapters/main/assets/llm-adapters-fellowship.jpg" alt="The fellowship: two cloud APIs and two local CLIs, all bound by one interface" width="70%" />

*The fellowship: two cloud APIs and two local CLIs, each with its own road, all bound by one interface.*
</div>

| Provider | Transport | Auth | Model discovery | Status |
|---|---|---|---|---|
| `claude-code` | Spawns the `claude` CLI, headless | Your `claude login` session | none — the CLI has no listing command | Production |
| `opencode` | Runs `opencode serve`, talks HTTP + SSE | Your `opencode auth login` providers | `opencode models` | Production |
| `openai-compatible` | Any OpenAI-protocol endpoint | API key + base URL | `GET {baseUrl}/models` | Validated |
| `anthropic` | Anthropic Messages API | API key | `GET /v1/models` | Production |

*Production* means real applications run it. *Validated* means it has been
exercised against a live server.

`claude-code` is the only adapter with agentic file tools; the others return
text. `supportsFileTools` reports that, except on `opencode`, where it reports
`false` as a **policy**: opencode has file tools and this adapter denies them,
at the server and per message.

## Why this and not the alternatives

**Why not call the APIs directly?** Because most applications end up wanting
both kinds of provider, and the two have nothing in common: one is a `fetch`
with a key, the other is resolving a binary, building a minimal environment,
spawning a process and parsing a stream of JSON events. Calling each directly
means two code paths and a branch at every call site — and no usage measurement
at all, because each provider reports consumption in its own shape and none of
them agree on what `null` means.

The honest cost: a layer you did not write, and a contract narrower than any one
provider's own API. If you use exactly one provider and will never change, the
direct call is simpler and you should make it.

**Why not an agent SDK?** They solve a different problem. An agent framework
gives you tool calling, memory and orchestration, and assumes an API key. This
does none of that. What it has that they do not is the CLI-spawn family — using
the `claude` or `opencode` binary the developer is already logged into, with no
key at all — and cost reporting that distinguishes "the provider said zero" from
"the provider did not say". If you want agent orchestration, take a framework;
this is the layer underneath one.

## What it does not do

Answered here rather than left to be discovered after integration.

**No tool calling.** There is no way to declare functions and receive structured
calls. `LLMStreamChunk` has a `tool_use` type, but it is a progress signal —
`claude-code` emitting it while the CLI works — not a calling convention.

**No multimodal input.** `LLMMessage.content` is a string. No images, no audio,
no documents.

**No HTTP serving, no caching, no wire translation.** Those are application
policy: two applications would reasonably want them to behave differently, so
they stay out. Configuration is a parameter — nothing here reads a config file
unless you call `loadConfig()` yourself.

## API

One entry point. Deep paths into the package are not part of the API, which is
what leaves the file layout free to change.

| Export | | |
|---|---|---|
| [`getLLMAdapter`](#getllmadapter) | function | Config in, adapter out |
| [`LLMAdapter`](#llmadapter) | type | The contract every adapter implements |
| [`LLMConfig`](#llmconfig) | type | What you pass to `getLLMAdapter` |
| [`LLMMessage`](#llmmessage) | type | One turn of the conversation |
| [`LLMStreamChunk`](#llmstreamchunk) | type | What `stream()` yields |
| [`StreamOptions`](#streamoptions) | type | Per-call options, opt-in per provider |
| [`LLMUsage`](#llmusage) | type | What a call consumed, as reported |
| [`PROVIDERS`](#providers-1) | const | The catalogue, keyed by provider id |
| [`PROVIDER_LIST`](#provider_list) | const | The same entries as an array, for a picker |
| [`DEFAULT_PROVIDER`](#default_provider) | const | `"claude-code"` |
| [`ProviderConfig`](#providerconfig) | type | A catalogue entry |
| [`loadConfig`](#loadconfig) | function | Resolve a provider's stored configuration |
| [`saveConfig`](#saveconfig) | function | Write one provider's block, merging |
| [`readStoredConfig`](#readstoredconfig) | function | The stored file as-is |
| [`CONFIG_PATH`](#config_path) | const | Where those two read and write |
| [`StoredConfig`](#storedconfig) | type | The file's shape |
| [`ProviderCredentials`](#providercredentials) | type | One provider's block |
| [`registerSecret`](#registersecret) | function | Scrub a value from what this package returns |
| [`extractUsage`](#extractusage) | function | Consumption out of a parsed CLI result event |
| [`readCliOutput`](#readclioutput) | function | Text and consumption out of CLI stdout |
| [`shutdown`](#shutdown) | function | Stop every process the package started |

### getLLMAdapter

```ts
function getLLMAdapter(config: LLMConfig): LLMAdapter;
```

The only place provider ids map to implementations. Throws on an unknown
provider and on a missing required credential — see [Errors](#errors).

### LLMAdapter

```ts
interface LLMAdapter {
  // Whether this adapter can write files itself through agentic tools,
  // instead of returning text for the caller to act on.
  readonly supportsFileTools: boolean;

  stream(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: StreamOptions
  ): AsyncGenerator<LLMStreamChunk>;

  complete(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: { model?: string; signal?: AbortSignal; maxTokens?: number; onUsage?: (usage: LLMUsage) => void }
  ): Promise<string>;

  // Optional, so a caller feature-detects rather than catching. Absent on
  // adapters whose provider cannot be asked; resolves to [] — never rejects —
  // when it can be asked and has no answer.
  listModels?(): Promise<string[]>;
}
```

### LLMConfig

```ts
interface LLMConfig {
  provider: "openai-compatible" | "anthropic" | "claude-code" | "opencode";
  baseUrl?: string;         // required by openai-compatible
  apiKey?: string;          // required by openai-compatible and anthropic
  model?: string;           // free text; empty falls back to the default
  claudeCodePath?: string;  // absolute override for the `claude` binary
  opencodePath?: string;    // absolute override for the `opencode` binary
  sessionTitle?: string;    // how your app names its opencode sessions
}
```

### LLMMessage

```ts
interface LLMMessage {
  role: "user" | "assistant";
  content: string;          // text only: see What it does not do
}
```

### LLMStreamChunk

```ts
interface LLMStreamChunk {
  type: "text" | "tool_use" | "done" | "error";
  text?: string;
  error?: string;
  details?: string;         // redacted before it reaches you: see Security
  status?: number;          // the provider's HTTP status, on an HTTP error only
}
```

`status` is set only when the error is the provider's own HTTP answer (a `429`,
say). It is absent — never `0` — for a network failure, an abort or a CLI
error, and the `error` text is the same either way.

A failing `stream()` yields `{ type: "error" }` rather than throwing, which
changes how you catch it — see [Errors](#errors).

### StreamOptions

```ts
interface StreamOptions {
  signal?: AbortSignal;                    // honoured by every adapter
  onUsage?: (usage: LLMUsage) => void;     // fires at most once per call
  cwd?: string;                            // claude-code only
  allowedTools?: string[];                 // claude-code only
  textOnly?: boolean;                      // claude-code only
  maxTurns?: number;                       // claude-code only
  maxTokens?: number;                      // anthropic, openai-compatible
}
```

`maxTokens` caps the output tokens of one call. `anthropic` sends it in place of
its default of 32000; `openai-compatible` sends `max_tokens` only when it is set.
The CLI adapters have no such flag and ignore it. A value that is not a positive
integer is not sent.

An adapter ignores the fields it has no use for. That is what lets one interface
cover subprocess providers and HTTP providers without either contaminating the
other.

### LLMUsage

```ts
interface LLMUsage {
  model: string | null;               // null when the provider named none
  models: string[];                   // every model the call touched
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;     // kept separate: on real CLI bills these
  cacheCreationTokens: number | null; // are the bulk of the total
  costUSD: number | null;             // reported, never computed here
  costBasis: string | null;           // "list" means list price, not what was billed
}
```

### PROVIDERS

```ts
const PROVIDERS: Record<LLMConfig["provider"], ProviderConfig>;
```

Suggestion lists and defaults, keyed by provider id. Never a limit: which models
a provider can reach depends on the account or CLI login behind it, so model
fields stay free text.

### PROVIDER_LIST

```ts
const PROVIDER_LIST: ProviderConfig[];
```

The same entries as an array, for rendering a picker.

### DEFAULT_PROVIDER

```ts
const DEFAULT_PROVIDER: string;   // "claude-code"
```

### ProviderConfig

```ts
interface ProviderConfig {
  id: string;
  label: string;
  description: string;
  models: string[];        // suggestions, never a limit
  defaultModel: string;
}
```

### loadConfig

```ts
function loadConfig(options?: { provider?: LLMConfig["provider"]; path?: string }): LLMConfig | null;
```

Resolves a provider's stored block into something `getLLMAdapter` takes. With no
argument it resolves the file's default block; with `{ provider }` it resolves
that one, which is what a provider selector needs. Returns `null` when nothing
is configured, and **throws** when a file exists and cannot be trusted, so
"unconfigured" and "misconfigured" never look alike.

### saveConfig

```ts
function saveConfig(
  config: LLMConfig,
  options: { includeApiKey: boolean; path?: string; makeDefault?: boolean }
): void;
```

Writes one provider's block, **merging** into whatever is already there, mode
`0600`. `includeApiKey` has no default: persisting a secret is a decision
somebody writes on purpose.

### readStoredConfig

```ts
function readStoredConfig(options?: { path?: string }): StoredConfig | null;
```

The stored file as-is, without resolving a provider — for a settings screen that
lists or edits what is configured rather than building one adapter.

### CONFIG_PATH

```ts
const CONFIG_PATH: string;   // ~/.llm-adapters/config.json
```

### StoredConfig

```ts
interface StoredConfig {
  default?: LLMConfig["provider"];
  providers?: Partial<Record<LLMConfig["provider"], ProviderCredentials>>;
}
```

### ProviderCredentials

```ts
type ProviderCredentials = Partial<
  Pick<LLMConfig, "apiKey" | "baseUrl" | "model" | "claudeCodePath" | "opencodePath" | "sessionTitle">
>;
```

One provider's block: the credential and path fields that provider uses.

### registerSecret

```ts
function registerSecret(value: string | undefined | null): void;
```

Scrub a value from everything this package returns. `getLLMAdapter` already
registers the key you hand it, so this is for a key that exists before an
adapter does — held by a settings screen, say.

### extractUsage

```ts
function extractUsage(obj: Record<string, unknown> | undefined): LLMUsage | null;
```

Consumption out of a parsed `claude --print --output-format json` result event.
`null` when there is nothing to report — never a zero-filled stand-in.

### readCliOutput

```ts
function readCliOutput(stdout: string, onUsage?: (usage: LLMUsage) => void): string;
```

Text out of that same CLI output, firing `onUsage` once if the output carried
consumption. Both of these are pure functions over text, so they work on output
you captured yourself, without an adapter and without spawning anything.

### shutdown

```ts
function shutdown(options?: { graceMs?: number }): Promise<void>;
```

Stops every process this package started and that is still running: the CLIs
of in-flight calls and the shared `opencode serve`. Each process group gets
`SIGTERM`, and after `graceMs` every one of those groups gets `SIGKILL`.
`graceMs` defaults to 3000, and a value that is not a finite number of zero or
more means the default. Concurrent calls share one run, and it never rejects.

The package installs no signal handler. Its CLIs run in their own process
group, so Ctrl-C does not reach them: a host that traps `SIGINT` or `SIGTERM`
calls this before it exits.

```ts
import { shutdown } from "@the-coded/llm-adapters";

process.once("SIGINT", async () => {
  await shutdown();
  process.exit(130);
});
```

Calls in progress fail: an in-flight `stream()` ends with an error chunk, and an
in-flight `complete()` rejects. On Windows only the direct child is signalled —
see [Runtimes](#runtimes).

A process spawned while a shutdown is already running is not covered by that
call; call `shutdown()` again. And a group whose leader had already exited
before the call cannot be reached, because the package no longer tracks it.

## Usage and cost

`onUsage` reports what a call consumed, as the provider reported it, at most
once per call. `StoredConfig`, `LLMUsage` and the rest are exported types, so
this is typed end to end.

```ts
await adapter.complete("Be terse.", messages, {
  onUsage: (u) => {
    // null means the provider did not say. It never means zero, and the
    // difference is the whole point: zero and unknown are the same number
    // inside a sum and opposite facts inside a spending decision.
    const dollars = u.costUSD === null ? "not reported" : `$${u.costUSD}`;
    const basis = u.costBasis ?? "unstated";  // "list" from the claude CLI
    console.log(`${u.model ?? "unknown model"}: ${dollars} (basis: ${basis})`);
  },
});
```

```ts
interface LLMUsage {
  model: string | null;               // null when the provider named none
  models: string[];                   // every model the call touched
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;     // kept separate: on real CLI bills these
  cacheCreationTokens: number | null; // are the bulk of the total
  costUSD: number | null;             // reported, never computed here
  costBasis: string | null;           // "list" means list price, not what was billed
}
```

Who reports what: `claude-code` reports tokens and dollars, from both
`complete()` and `stream()`. `opencode` sums a session's steps and
reports once, tokens and dollars, with `costBasis` null because it
derives cost from a price table and declares no basis. `anthropic` and
`openai-compatible` report token counts from `complete()` only: neither
API returns a price, so no dollars are invented, and their `stream()`
does not report yet.

## Model discovery

```ts
// Feature-detect: a missing method means the provider cannot be asked at all,
// and falling back to the catalogue is then your choice, made knowingly.
const models = (await adapter.listModels?.()) ?? PROVIDERS[config.provider].models;
```

An adapter that can be asked but has no answer — no CLI installed, a gateway
without a `/models` route — resolves to `[]` rather than rejecting. A machine
that never set a CLI up is a normal state, not an error, and discovery failing
must never make a provider vanish from a picker. Caching is yours: a settings
dropdown and a public endpoint want very different freshness, and `opencode`
costs a process spawn per call.

## Shared configuration

```ts
import { getLLMAdapter, loadConfig } from "@the-coded/llm-adapters";

// The file's default block.
const adapter = getLLMAdapter(loadConfig() ?? { provider: "claude-code" });

// Or a named one, which is what a provider selector actually needs: it
// resolves that provider's own credentials rather than re-reading the file.
const gateway = getLLMAdapter(loadConfig({ provider: "openai-compatible" })!);
```

`~/.llm-adapters/config.json` lets several applications share one provider
setup instead of each inventing its own store. **Credentials are per provider**,
in blocks, the way `~/.aws/credentials` keeps profiles:

```json
{
  "default": "anthropic",
  "providers": {
    "anthropic": { "apiKey": "…", "model": "claude-opus-5" },
    "openai-compatible": { "apiKey": "…", "baseUrl": "http://localhost:20128/v1" }
  }
}
```

One key for the whole file was the earlier shape, and it meant a key saved for
one vendor was handed to whichever provider you selected next. The environment
already distinguished — `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` apply only to
their own vendor and beat the file — so this was the one place that could not do
what the rest already did.

The file is written mode `0600` and **refused** if it is readable by group or
other, the way ssh refuses a key. `saveConfig` merges, so writing one provider's
credentials never disturbs another's. `apiKey` is written only when you pass
`includeApiKey: true`, which means the common setup here — the two CLI providers,
which use no key — produces a file with no secret in it.

## Errors

**Two channels, and they are caught differently.** `complete()`, `getLLMAdapter`
and the config helpers **throw**. `stream()` does not: a failure arrives as a
`{ type: "error" }` chunk in the iteration, so a `try/catch` around the loop will
not see it.

```ts
import { getLLMAdapter } from "@the-coded/llm-adapters";

try {
  const adapter = getLLMAdapter(config);        // throws on bad configuration
  const answer = await adapter.complete(system, messages);   // throws on failure
} catch (err) {
  // Every message from this package is written to be acted on: it names what is
  // missing and what to do about it. It is also redacted -- no home directory,
  // no username, no API key -- so it is safe to log.
  console.error((err as Error).message);
}

for await (const chunk of adapter.stream(system, messages)) {
  if (chunk.type === "error") {
    // `error` is the summary, `details` the provider's own output.
    console.error(chunk.error, chunk.details);
    break;
  }
}
```

Errors are plain `Error`s with actionable messages rather than typed classes;
match on the message if you must branch, and prefer branching on the condition
you can check first.

| Thrown by | When | Message begins |
|---|---|---|
| `getLLMAdapter` | the provider id is not one of the four, including inherited keys like `toString` | `Unknown LLM provider:` |
| `getLLMAdapter` | `openai-compatible` without `baseUrl` or `apiKey` | `openai-compatible provider requires` |
| `getLLMAdapter` | `anthropic` without `apiKey` | `anthropic provider requires` |
| `complete()` | the endpoint streamed a response to a non-streaming request | `…: the server streamed a response` |
| `complete()` | the provider returned a non-ok status | `…request failed (<status>):` |
| `complete()`, `stream()` | the `claude` binary is not on PATH and not at any known path | `claude CLI not found:` |
| `complete()`, `stream()` | `claudeCodePath` is set but not absolute, an empty string included | `claudeCodePath must be an absolute path` |
| `complete()`, `stream()` | `claudeCodePath` is absolute but not an executable file | `claudeCodePath points at` |
| `complete()`, `stream()` | the opencode binary (`opencodePath`, or `opencode` on PATH) cannot be started | `opencode server failed to start` |
| `complete()`, `stream()` | the opencode model is not `provider/model` | `opencode model must be` |
| `loadConfig`, `saveConfig` | the config file is readable by group or other | `refusing to read …: mode` |
| `loadConfig`, `saveConfig` | the config file is malformed or a field has the wrong type | `refusing to read …:` |

A missing config file is not an error: `loadConfig` returns `null`. That
distinction is deliberate — "unconfigured" and "misconfigured" need different
answers, and collapsing them is how a permission problem becomes a mystery.

`listModels()` never throws. Where a provider can be asked and has no answer —
no CLI installed, a gateway without a `/models` route — it resolves to `[]`.

## Security

Everything this package returns passes through a redactor: absolute path forms,
the running user's home and username, and any API key it has been handed are
removed from error details and thrown messages. An error message is the most
likely thing to reach a log, an issue or an error tracker, which makes it about
as public as a commit and far more frequent.

The CLI adapters spawn a local binary with your process's privileges, never
through a shell, with a narrow environment allowlist rather than a copy of
yours. Report a vulnerability to **gabriel@laplanta.com.br** rather than in a public
issue.

## Runtimes

| Runtime | Support |
|---|---|
| Node | 22 and newer. CI runs the suite on Node 22 and Node 24. |
| Bun | Supported. CI runs the same compiled output under Bun. |
| TypeScript | 5.x. Declarations are shipped; `moduleResolution` must resolve `exports`. |
| Deno | Untested. |
| Browsers, Workers, Edge runtimes | The two HTTP adapters use only `fetch` and should work. **The two CLI adapters cannot**: they spawn a child process, which those runtimes do not have. |
| Windows | Untested, and one known limit: aborting a CLI adapter, or calling `shutdown()`, signals the direct child rather than its process group there, so a CLI that spawns children can leave them running. |

The CLI-spawn family is the interesting line in that table: it is what this
package has that an SDK does not, and it is also the reason the package is not
universal. Choose the provider to match where you deploy.

`claude-code` and `opencode` spawn vendor CLIs, so their `stream()` and
`complete()` paths cannot be exercised by an automated suite without those CLIs
installed and authenticated. That gap is covered by the applications that run
them in production, which is weaker than a test and is said here rather than
found later.

## Versioning

[Semantic Versioning](https://semver.org). A breaking change is any change to:

- the exported types, or the signature of an exported function;
- the shape of the stored configuration file;
- the exit codes of the scripts in `examples/`;
- what `null` means in `LLMUsage`.

**Below 1.0, a minor version may break.** npm's caret already treats a `0.x`
minor as breaking (`^0.1.0` will not install `0.2.0`), but a looser range such
as `~0` or `>=0.1.0` will.

Every breaking change is recorded in [CHANGELOG.md](./CHANGELOG.md) and marked
**Breaking**.

## Licence

[MIT](./LICENSE).
