import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerSecret } from "./redact.js";
import type { LLMConfig } from "./types.js";

/** An **opt-in** helper for the configuration several applications were each
 *  storing their own way — one in a project JSON file, one in `localStorage`,
 *  one bespoke. Three places holding one shape.
 *
 *  **The library core still reads nothing.** `getLLMAdapter` takes a parameter
 *  and always will; this module is something a caller chooses to call and pass
 *  the result of. That is what keeps the package's own suite hermetic and what
 *  stops a library having opinions about a machine it is merely installed on.
 *
 *  **Credentials are per provider**, in blocks, the way `~/.aws/credentials`
 *  keeps profiles. An earlier version had one `apiKey` for the whole file, and
 *  a demo proved what that means the first time it was used: with a key saved
 *  for one provider, selecting another sent that key to the wrong vendor and got
 *  back "API key is invalid". The environment already distinguished —
 *  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are read per provider — so the file
 *  was the only part of the system that could not do what the rest already did.
 *
 *  **On keeping a key in a file.** An older rule here said keys live in the
 *  environment and never in a file. That rule's real content was *do not commit
 *  a key*, and `$HOME` is not a repository. An environment variable is not the
 *  safer option it sounds like: readable by any process of the same user,
 *  inherited by children, and present in crash dumps and CI logs. A mode-0600
 *  file is what `~/.aws/credentials`, `~/.npmrc`, `~/.docker/config.json`, the
 *  `gh` CLI and the `claude` CLI all use. The permission check below is what
 *  makes that true rather than assumed.
 */

/** `~/.llm-adapters/config.json`. */
export const CONFIG_PATH = join(homedir(), ".llm-adapters", "config.json");

type ProviderId = LLMConfig["provider"];

/** What one provider's block may carry: exactly the fields that provider uses,
 *  minus `provider` itself, which is the key the block is filed under. */
export type ProviderCredentials = Partial<
  Pick<LLMConfig, "apiKey" | "baseUrl" | "model" | "claudeCodePath" | "opencodePath" | "sessionTitle">
>;

/** The file's shape. */
export interface StoredConfig {
  /** Which block `loadConfig()` resolves when the caller names no provider. */
  default?: ProviderId;
  providers?: Partial<Record<ProviderId, ProviderCredentials>>;
}

const PROVIDER_IDS: readonly ProviderId[] = ["openai-compatible", "anthropic", "claude-code", "opencode"];
const CREDENTIAL_FIELDS = ["apiKey", "baseUrl", "model", "claudeCodePath", "opencodePath", "sessionTitle"] as const;

/** Variables read for every provider, plus the vendor-conventional ones, which
 *  apply **only** to the provider they belong to. That last part is the whole
 *  point: `ANTHROPIC_API_KEY` must not become an `openai-compatible` key just
 *  because it happens to be exported. */
const GENERIC_ENV: Record<string, keyof ProviderCredentials> = {
  LLM_ADAPTERS_API_KEY: "apiKey",
  LLM_ADAPTERS_BASE_URL: "baseUrl",
  LLM_ADAPTERS_MODEL: "model",
  LLM_ADAPTERS_CLAUDE_CODE_PATH: "claudeCodePath",
  LLM_ADAPTERS_OPENCODE_PATH: "opencodePath",
  LLM_ADAPTERS_SESSION_TITLE: "sessionTitle",
};
const VENDOR_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

/** Environment overrides for one provider.
 *
 *  **Precisely: a *non-empty* variable wins.** `LLM_ADAPTERS_MODEL=""` falls
 *  back to the file rather than clearing the field, matching how the factory
 *  treats an empty model — an untouched free-text field is not a decision to
 *  send an empty model to a provider. "Environment always wins" is the shorter
 *  sentence and not the true one. */
function fromEnv(provider: ProviderId): ProviderCredentials {
  const out: ProviderCredentials = {};
  for (const [name, field] of Object.entries(GENERIC_ENV)) {
    const value = process.env[name];
    if (value) out[field] = value;
  }
  const vendor = VENDOR_ENV[provider];
  if (vendor && process.env[vendor]) out.apiKey = process.env[vendor];
  return out;
}

/** **Declared limit: the directory's mode is not checked.** A `0777` directory
 *  holding a `0600` file is read without complaint, and a directory writable by
 *  others allows the file to be swapped for another. ssh checks the containing
 *  directory in some cases; this does not, and saying so beats leaving a reader
 *  to assume the check is broader than it is. `saveConfig` creates the directory
 *  `0700`, so the gap only opens on a directory somebody else made. */
function assertPrivate(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `refusing to read ${path}: mode ${mode.toString(8).padStart(3, "0")} is readable by group or other. Run \`chmod 600 ${path}\`.`,
    );
  }
}

const refuse = (path: string, why: string): never => {
  throw new Error(`refusing to read ${path}: ${why}`);
};

/** Parses and validates the file, or throws with a message somebody can act on.
 *
 *  Every refusal here has the same shape as the permission one, because a
 *  promise of an actionable message that holds for some failures and not others
 *  is the same defect as a declaration that overstates its reach. */
function readFile(path: string): StoredConfig {
  assertPrivate(path);
  // The BOM goes before parsing: a file saved by a Windows editor is a normal
  // thing to receive, and `JSON.parse` answers it with `Unexpected token`.
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    refuse(path, `it is not valid JSON (${(err as Error).message}).`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse(path, `expected a JSON object, found ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}.`);
  }
  const object = parsed as Record<string, unknown>;

  // Only the top level is closed. An unrecognised key is refused rather than
  // ignored: ignored, a file in any other shape read as an empty config, and the
  // next save rewrote it without the credentials it held. A new top-level field
  // is a version bump, not a silent extra key. Unknown provider ids below are
  // still skipped.
  for (const key of Object.keys(object)) {
    if (key !== "default" && key !== "providers") {
      refuse(path, `unknown top-level key ${JSON.stringify(key)}; expected "default" and "providers".`);
    }
  }

  if (object.default !== undefined && !PROVIDER_IDS.includes(object.default as ProviderId)) {
    refuse(path, `"default" is ${JSON.stringify(object.default)}; expected one of ${PROVIDER_IDS.join(", ")}.`);
  }

  const providers: StoredConfig["providers"] = {};
  const raw_providers = (object.providers ?? {}) as Record<string, unknown>;
  if (typeof raw_providers !== "object" || raw_providers === null || Array.isArray(raw_providers)) {
    refuse(path, `"providers" should be an object keyed by provider id.`);
  }
  for (const [id, block] of Object.entries(raw_providers)) {
    if (!PROVIDER_IDS.includes(id as ProviderId)) continue; // forward compatibility
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      refuse(path, `"providers.${id}" should be an object.`);
    }
    const credentials: ProviderCredentials = {};
    for (const field of CREDENTIAL_FIELDS) {
      const value = (block as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        refuse(path, `"providers.${id}.${field}" should be a string, found ${value === null ? "null" : typeof value}.`);
      }
      credentials[field] = value as string;
    }
    providers[id as ProviderId] = credentials;
  }

  return { ...(object.default !== undefined ? { default: object.default as ProviderId } : {}), providers };
}

/** Reads the stored file as-is, without resolving a provider.
 *
 *  For a caller that wants to list or edit what is configured — a settings
 *  screen — rather than build one adapter. Returns `null` when there is no
 *  file. */
export function readStoredConfig(options?: { path?: string }): StoredConfig | null {
  const path = options?.path ?? CONFIG_PATH;
  try {
    const stored = readFile(path);
    registerEveryKey(stored);
    return stored;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** **Every** key in the file, not only the selected provider's.
 *
 *  Any of them can surface in an error, and registering just the active one
 *  would reopen the redaction hole for the rest — the same shape as registering
 *  a key only inside this helper, which protected the path nobody used. */
function registerEveryKey(stored: StoredConfig): void {
  for (const block of Object.values(stored.providers ?? {})) registerSecret(block?.apiKey);
}

/** Resolves one provider's configuration into something `getLLMAdapter` takes.
 *
 *  `loadConfig()` resolves the file's `default` block, so
 *  `getLLMAdapter(loadConfig() ?? { provider: "claude-code" })` stays one line.
 *  `loadConfig({ provider })` resolves a named block, which is what makes a
 *  provider selector a real call rather than a re-read of the file.
 *
 *  Returns `null` when there is nothing to resolve — no file, no environment,
 *  and no provider named — so a caller can tell "unconfigured" from
 *  "configured empty" without catching. A file that exists and cannot be
 *  trusted **throws**: that is a refusal, not an absence, and treating it as an
 *  absence is how a permission problem becomes a mystery. */
export function loadConfig(options?: { provider?: ProviderId; path?: string }): LLMConfig | null {
  const path = options?.path ?? CONFIG_PATH;
  const stored = readStoredConfig({ path });

  const envProvider = process.env.LLM_ADAPTERS_PROVIDER as ProviderId | undefined;
  const provider =
    options?.provider ??
    (envProvider && PROVIDER_IDS.includes(envProvider) ? envProvider : undefined) ??
    stored?.default;
  if (!provider) return null;

  const block = stored?.providers?.[provider] ?? {};
  const env = fromEnv(provider);
  const resolved: LLMConfig = { ...block, ...env, provider };

  // Registered again for the resolved value, since an environment key never
  // passed through the file and would otherwise be unknown to the redactor.
  registerSecret(resolved.apiKey);
  return resolved;
}

/** Writes one provider's credentials, **merging** into whatever is already
 *  there.
 *
 *  The merge is the load-bearing part. A naive write replaces the file and
 *  silently destroys every other provider's key, and nobody finds out until
 *  they switch back to one of them.
 *
 *  **The key is not written unless the caller says so.** `includeApiKey` has no
 *  default and has to be passed: persisting a secret is a decision somebody
 *  makes on purpose, never a side effect of saving the other fields. The common
 *  case here is `claude-code` and `opencode`, which use no key at all, so an
 *  ordinary file contains no secret.
 *
 *  The first provider written becomes `default` if the file has none, because a
 *  file whose `default` is unset makes `loadConfig()` return `null` and nothing
 *  work. An existing `default` is changed only when `makeDefault` says to. */
export function saveConfig(
  config: LLMConfig,
  options: { includeApiKey: boolean; path?: string; makeDefault?: boolean },
): void {
  const path = options.path ?? CONFIG_PATH;
  const dir = join(path, "..");

  let existing: StoredConfig = {};
  try {
    existing = readFile(path);
  } catch (err) {
    // A missing file is the normal first write. Anything else is a real
    // refusal and must not be papered over by overwriting the file.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const { provider, apiKey, ...rest } = config;
  const block: ProviderCredentials = {};
  for (const field of CREDENTIAL_FIELDS) {
    if (field === "apiKey") continue;
    const value = (rest as Record<string, unknown>)[field];
    if (typeof value === "string" && value) block[field] = value;
  }
  if (options.includeApiKey && apiKey) block.apiKey = apiKey;

  const next: StoredConfig = {
    default: options.makeDefault ? provider : (existing.default ?? provider),
    providers: { ...existing.providers, [provider]: { ...existing.providers?.[provider], ...block } },
  };

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // `mode` on `writeFileSync` is ignored for a file that already exists, so the
  // permission is set explicitly rather than hoped for. Without this, a config
  // created world-readable stays world-readable and the next read refuses a
  // file this very function just wrote.
  chmodSync(path, 0o600);

  registerSecret(apiKey);
}
