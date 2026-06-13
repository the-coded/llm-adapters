// The package's single entry point. Deep paths into `dist/` are not part of the
// API, which is what leaves the file layout under `src/` free to change —
// see docs/adr/0001-published-contract.md, decision 2.

export { getLLMAdapter } from "./factory.js";
// `PROVIDER_LIST` looks unused and is not: **nothing in this repository imports
// it**, and a consumer's settings screen is the only thing anywhere that
// does. A tidy-up deleting it as a dead export would break
// the one consumer that would notice, silently, and that consumer is not
// migrated yet so no build here would go red. Same for `DEFAULT_PROVIDER`.
export { PROVIDERS, PROVIDER_LIST, DEFAULT_PROVIDER } from "./providers.js";

// The two pure parsers of the `claude` CLI's JSON output. Exported because a
// consumer may need to read usage out of CLI output it captured itself,
// without going through an adapter — and because a test that had been
// deep-importing the adapter file has nowhere else to reach them once the
// package's only public path is this barrel.
export { extractUsage, readCliOutput } from "./adapters/claude-code.js";

// Opt-in, and deliberately not used by `getLLMAdapter`: the core reads no
// configuration and takes a parameter instead. A caller that wants the shared
// file calls `loadConfig()` and passes the result in.
export { CONFIG_PATH, loadConfig, readStoredConfig, saveConfig } from "./config.js";

// For an application that obtains a key by some path of its own -- a settings
// screen, a secrets manager -- and wants it scrubbed from anything this package
// returns. `getLLMAdapter` registers the key it is given, so this is only
// needed when a key exists before an adapter does.
export { registerSecret } from "./redact.js";
export type { ProviderCredentials, StoredConfig } from "./config.js";

export type {
  LLMAdapter,
  LLMConfig,
  LLMMessage,
  LLMStreamChunk,
  LLMUsage,
  ProviderConfig,
  StreamOptions,
} from "./types.js";
