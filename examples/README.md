# examples

A validation harness, not a tutorial. One command per provider, against the
real thing, printing what actually came back.

```sh
node examples/run.ts claude-code
bun  examples/run.ts opencode
```

Run it with no argument for the provider list. It needs the package built
first — `npm run build` — because it imports the package by name rather than
reaching into `src/`, which is also what makes it a test of the published entry
point rather than of the source tree.

## What each run does

`listModels()` where the adapter has it, then `stream()` with the text arriving
live, then `complete()`, then the usage report. Every call carries a 60-second
deadline.

**Nothing throws and nothing hangs.** A provider that is not set up prints what
is missing and the process exits cleanly. That is deliberate and it is the
sharper half of the two: an exception names a file and a line, while a hung
process looks like a slow network and costs somebody twenty minutes before they
suspect the tool.

**The usage report states provenance.** A `null` cost prints as *"not reported
by the provider (unknown, not zero)"* — never as `0`, never as a missing line.
Token counts do the same. That distinction is what the package exists to
protect, so a harness that erased it would contradict the library it exercises.

## Exit codes

A harness that always exits `0` lies to whatever runs it.

| Code | Meaning |
|---|---|
| `0` | ran, and both `stream()` and `complete()` worked |
| `1` | wrong usage: no provider, or one that does not exist |
| `2` | not configured: the provider needs something it was not given |
| `3` | configured, and a call failed |

`2` and `3` are separate on purpose. It is the same distinction `loadConfig`
draws between a file that is absent and one that is corrupt, and a script needs
to tell "nobody set this up" from "this is set up and does not work".

It reads configuration through `loadConfig()`, so running it is also a test of
that helper: `~/.llm-adapters/config.json` if you have one, environment
variables if you do not, and neither is required.

## What each provider needs

| Provider | Needs | If it is missing |
|---|---|---|
| `claude-code` | the `claude` CLI, logged in | the error names every path it looked in, and whether the problem is PATH or installation |
| `opencode` | the `opencode` CLI, authenticated | the spawn failure is reported as text |
| `openai-compatible` | `LLM_ADAPTERS_BASE_URL` and an API key | the run stops before any request, saying which of the two |
| `anthropic` | `ANTHROPIC_API_KEY` | the same |

Keys come from the environment or from `~/.llm-adapters/config.json`, which is
written mode `0600` and refused if anything else can read it. Nothing here
writes a key anywhere.

## What a real run looked like

Measured against live servers rather than described:

- **`claude-code`** reports on both paths, tokens and dollars, with
  `costBasis: "list"` — list price, which is a fact about the call rather than
  what was billed to an account with an allowance.
- **`openai-compatible`** against a local gateway: `listModels()` returned a
  full catalogue, and the usage came back as token counts with no dollars,
  because the protocol carries no price.
- **`opencode`** listed its models and then hit a plan refusal from the provider
  behind it. That is a result, not a failure of the adapter: the harness prints
  the refusal and moves on.
- **`anthropic`** was not run through this harness. Its status in the main
  README comes from applications that ran this code against the live API
  before it became a package.
