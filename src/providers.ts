import type { LLMConfig, ProviderConfig } from "./types.js";

/** The static provider catalog.
 *
 *  Every `models` array here is a **suggestion list, not a limit**. Which
 *  models a provider can actually reach depends on the account or the CLI login
 *  behind it, so a caller keeps its model field free text and treats this as a
 *  starting point — see `LLMAdapter.listModels()` for asking the provider
 *  itself.
 *
 *  Typed by the provider union rather than `Record<string, ...>` so that
 *  indexing it with an `LLMConfig["provider"]` is statically known to hit, and
 *  the catalog cannot silently lose an entry a factory branch depends on.
 *
 *  Model IDs current as of 2026-05-12; update here if they drift. */
export const PROVIDERS: Record<LLMConfig["provider"], ProviderConfig> = {
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible (BYOK)",
    description: "Any OpenAI-protocol endpoint — OpenRouter, 9router, etc. Requires baseUrl + apiKey.",
    models: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"],
    defaultModel: "anthropic/claude-opus-5",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (BYOK)",
    description: "Native Anthropic Messages API. Requires apiKey.",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"],
    defaultModel: "claude-opus-5",
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code (local CLI)",
    description:
      "Runs the `claude` CLI as a subprocess with built-in file tools. No API key — uses your `claude login` session. Must be installed globally.",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"],
    defaultModel: "claude-opus-5",
  },
  opencode: {
    id: "opencode",
    label: "opencode (local server)",
    description:
      "Runs `opencode serve` and talks to it over HTTP. No API key — uses whatever you configured with `opencode auth login`, so any provider it supports. Models are `provider/model`; run `opencode models` for the list.",
    // Examples, not a catalog. `OpenCodeAdapter.listModels()` fills a real
    // suggestion list at runtime by asking the CLI, because what is reachable
    // depends on which providers the user authenticated — these two only cover
    // the case where the CLI cannot be asked.
    models: ["cline-pass/cline-pass/deepseek-v4-pro", "openai/gpt-5.5"],
    defaultModel: "cline-pass/cline-pass/deepseek-v4-pro",
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS);
export const DEFAULT_PROVIDER = "claude-code";
