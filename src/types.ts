// The `LLMAdapter` contract: one interface for every way an application talks
// to an LLM, whether that is an HTTP API behind a key or a vendor CLI spawned
// as a subprocess.
//
// The shape is deliberate and is documented in SYSTEM-DESIGN.md: a single
// interface covers both provider families, and provider-specific concerns are
// opt-in through `StreamOptions` rather than leaking subprocess vocabulary into
// the API adapters' own signatures.

export interface ProviderConfig {
  id: string;
  label: string;
  description: string;
  models: string[];
  defaultModel: string;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMStreamChunk {
  type: "text" | "tool_use" | "done" | "error";
  text?: string;
  error?: string;
  /** Detailed error output (e.g. full stderr) for debugging */
  details?: string;
}

/**
 * Options for streaming — provider-specific fields an adapter doesn't need
 * are simply ignored. This is what lets one interface cover both API and
 * CLI-spawn providers without leaking subprocess concerns into the API
 * adapters' own contract.
 *
 * - claude-code uses: cwd, allowedTools, maxTurns, signal
 * - openai-compatible / anthropic ignore all but signal (they should honor
 *   `signal` too once wired — see each adapter)
 */
export interface StreamOptions {
  /** Working directory for the LLM process (claude-code only) */
  cwd?: string;
  /** Auto-approve these CLI tools (claude-code only), e.g. ["Read"].
   * NOT a restriction: tools left out of this list are still available, they
   * just go through the permission mode. Use `textOnly` to actually take
   * tools away. */
  allowedTools?: string[];
  /** Use the CLI as a plain completion: text in, text out, with nothing but
   * the prompt shaping the answer (claude-code only).
   *
   * Three things, because three separate mechanisms can add behaviour:
   * the built-in tools, the MCP servers the CLI inherits from the developer's
   * own config (a plugin's MCP tools can include arbitrary code execution),
   * and the developer's personal customizations — hooks, skills, CLAUDE.md.
   * That last one is not cosmetic: an injected persona can contradict the
   * caller's own instructions.
   *
   * The point is reproducibility — the same prompt behaves the same on any
   * machine, whatever the developer has installed. */
  textOnly?: boolean;
  /** Max agentic turns (claude-code only) */
  maxTurns?: number;
  /** Abort signal — a caller wires its request's signal here so a client
   * disconnect kills the spawned CLI / in-flight fetch instead of leaking it. */
  signal?: AbortSignal;
  /** Called ONCE per provider call, when the provider reports what it
   *  consumed. Optional on both sides: a caller that does not pass it pays
   *  nothing, and a provider that does not know its own consumption does not
   *  call it -- silence means "unknown", and the difference between that and
   *  zero is exactly what a spend display has to show. */
  onUsage?: (usage: LLMUsage) => void;
}

/** What one call consumed, **as reported by the provider**, never computed
 *  here. It arrives through `onUsage` instead of changing what `complete`
 *  returns: test doubles of the form `{ complete: async () => fixture }` are
 *  everywhere in consumer suites, and changing the signature would break all
 *  of them to add one optional datum. Additive growth in the options bag,
 *  exactly the way `signal` grew.
 *
 *  **`costUSD: null` is the centrepiece, not a typing detail.** Zero and
 *  "unknown" are the same thing inside a sum and opposite things inside a
 *  spending decision. A provider that does not report dollars **does not call
 *  the callback**; it returns no zero and estimates nothing.
 *
 *  Cache tokens are kept **separate** from the rest on purpose: in the real
 *  CLI they are the bulk of the bill (measured 2026-06-13: 25,305 cache
 *  creation and 7,557 cache read against 908 input), and folding them into one
 *  total makes the most important fact about the invoice disappear. */
export interface LLMUsage {
  /** The model the provider says it used. When it reports more than one in a
   *  single call, this is the one that consumed the most -- and `models` keeps
   *  all of them, because losing that would turn "I spent on two models" into
   *  "I spent on one".
   *
   *  `null` when the provider named no model at all, which happens on the path
   *  where it reports a total cost and no breakdown. It was `""` briefly, and
   *  that is the "empty means unknown" pattern the rest of this interface had
   *  just finished abandoning: an empty string is a value, and a caller
   *  displaying it shows a blank where it should show "unknown".
   *
   *  `models` stays `string[]` rather than nullable, because an empty list
   *  already means exactly what it says -- no models were named. */
  model: string | null;
  models: string[];
  /** Token counts are `number | null` for the same reason `costUSD` is, and it
   *  took a review to notice the inconsistency: "zero and unknown are the same
   *  number in a sum and opposite facts in a decision" was the argument for
   *  making dollars nullable, and it applies unchanged to tokens. A provider
   *  that reports a total cost but no breakdown genuinely does not know these,
   *  and filling them with `0` makes a call that consumed an unknown amount
   *  look like a call that consumed nothing. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Dollars reported BY THE PROVIDER. `null` when it does not report them —
   *  never 0, never estimated, and never negative: a negative cost is not a
   *  refund this package knows how to read, it is a malformed number heading
   *  into somebody's spend total, so it is treated as not reported.
   *
   *  Measured against the real CLI: it returns `costBasis: "list"`, i.e. **list
   *  price**. That is a fact about the call, not necessarily what was billed to
   *  someone on a plan with an allowance — which is why a caller should name
   *  the provenance rather than present the number as an invoice. */
  costUSD: number | null;
  /** What the provider says the price is based on -- `"list"` in today's CLI,
   *  i.e. **list price**. Stored raw, untranslated: a caller names what it got,
   *  and if another basis ever arrives it shows that one instead.
   *
   *  It exists because handing over a "real cost" that is actually list price,
   *  without saying so, would be the same defect as an estimate that hid its
   *  provenance -- just better disguised. `null` when the provider is silent. */
  costBasis: string | null;
}

export interface LLMAdapter {
  /** Whether this adapter can write files itself via agentic tools
   * (claude-code, given cwd+allowedTools) instead of just returning text
   * for the caller to parse. */
  readonly supportsFileTools: boolean;

  /** Stream a completion. Yields chunks as they arrive. */
  stream(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: StreamOptions
  ): AsyncGenerator<LLMStreamChunk>;

  /** Non-streaming completion. Returns the full response text.
   *
   *  `signal` here is the same abort mechanism `StreamOptions.signal`
   *  documents above, just on the narrower options `complete` has always
   *  taken — added because callers that invoke `complete` directly otherwise
   *  have NO way to stop the spawned CLI on client disconnect or a
   *  caller-level timeout, unlike every `stream` caller. */
  complete(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: { model?: string; signal?: AbortSignal; onUsage?: (usage: LLMUsage) => void }
  ): Promise<string>;

  /** The models this provider can actually reach, asked of the provider
   *  itself. **Optional on purpose**: an adapter whose provider has no way to
   *  be asked simply does not have this method, so a caller feature-detects
   *  (`adapter.listModels?.()`) instead of catching an exception to find out.
   *
   *  Where the provider *can* be asked but the answer is unavailable — the CLI
   *  is not installed, nobody authenticated — this resolves to `[]` rather
   *  than rejecting. A machine that has not set a CLI up is a normal state,
   *  not an error.
   *
   *  The result is a **suggestion list, never a limit**: which models a CLI
   *  reaches depends on what the person running it authenticated with, so a
   *  caller should keep its model field free text and use this to make typing
   *  easier. */
  listModels?(): Promise<string[]>;
}

/** Caller-supplied BYOK configuration. Nothing here is read from disk by this
 *  package: configuration arrives as a parameter, always. */
export interface LLMConfig {
  provider: "openai-compatible" | "anthropic" | "claude-code" | "opencode";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Override path to the `claude` binary (claude-code provider only) —
   * used when it isn't on the fixed candidate list `findClaudeBin()` checks
   * (custom install location, version manager, etc.). */
  claudeCodePath?: string;
  /** Override path to the `opencode` binary (opencode provider only), for the
   * same reason `claudeCodePath` exists: a version manager or a custom install
   * puts it somewhere the PATH of a spawned process does not reach. */
  opencodePath?: string;
  /** Title given to the session this package opens on the opencode server
   * (opencode provider only). It is how a caller recognises its own sessions
   * in `opencode`'s own listings, so the calling application's name is the
   * useful value. Defaults to `"llm-adapters"`. */
  sessionTitle?: string;
}
