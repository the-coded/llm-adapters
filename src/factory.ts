import type { LLMAdapter, LLMConfig } from "./types.js";
import { OpenAICompatibleAdapter } from "./adapters/openai.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { PROVIDERS } from "./providers.js";
import { registerSecret } from "./redact.js";

export function getLLMAdapter(config: LLMConfig): LLMAdapter {
  // Registered HERE, where the key enters the library, and not only inside the
  // optional config helper. A caller passing `apiKey` directly never touches
  // `config.ts` -- by design -- so registering only there protected the new path
  // and left the old one exactly as it was, which is the opposite of what the
  // redaction was for. Every existing consumer passes the key this way.
  registerSecret(config.apiKey);

  // Validated BEFORE the catalog is read, because a provider id that is not in
  // the catalog used to die on `undefined.defaultModel` — a TypeError naming an
  // internal field — and only reached the actionable message below when the
  // caller happened to pass an explicit model. The id can be wrong at runtime
  // whatever the type says: callers read it out of free-form configuration.
  //
  // Coerced to a string ONCE, and every later step reads that one value.
  //
  // Not a style choice: `Object.hasOwn(PROVIDERS, config.provider)` followed by
  // `PROVIDERS[config.provider]` converts the value **twice**, and a value is
  // free to answer differently each time. An object whose `[Symbol.toPrimitive]`
  // returns `"claude-code"` and then `"nope"` passes the guard and dies on the
  // lookup with `Cannot read properties of undefined` — precisely the TypeError
  // this guard exists to prevent. One conversion, one value, no window.
  //
  // `String(...)` rather than a template literal because `${sym}` throws
  // `Cannot convert a Symbol value to a string` before any message can form,
  // and a caller passing the wrong type deserves the documented error rather
  // than a stack from inside string interpolation.
  //
  // One observable consequence, noted rather than defended: values that used to
  // throw now construct, because they convert to a valid id. `["claude-code"]`
  // and `{ toString: () => "claude-code" }` are the examples. That follows from
  // coercing at all, it is coherent with how every other JS API treats a
  // stringifiable key, and it is a contract change for anyone who was relying on
  // an array being rejected.
  let id: string;
  try {
    id = String(config.provider);
  } catch {
    // A value whose own `toString` throws would otherwise propagate the
    // caller's error from in here, which reads as a bug in this package.
    throw new Error("Unknown LLM provider: <value that cannot be converted to a string>");
  }

  // `Object.hasOwn`, not a truthiness check on the lookup: `PROVIDERS` is an
  // object literal, so it inherits `Object.prototype` and `PROVIDERS["toString"]`
  // is a truthy function. A `if (!PROVIDERS[id])` guard waves `toString`,
  // `constructor`, `valueOf` and `hasOwnProperty` straight through to the
  // `switch`, where they fall to `default:` — which is why that branch is
  // load-bearing rather than the belt this comment once claimed it was.
  if (!Object.hasOwn(PROVIDERS, id)) {
    throw new Error(`Unknown LLM provider: "${id}"`);
  }
  const provider = PROVIDERS[id as LLMConfig["provider"]];

  // `||`, not `??` — an empty string (unset free-text model field) must
  // also fall back to the default, not be sent to the provider as-is.
  const model = config.model || provider.defaultModel;

  // Switched on the same single coercion, not on `config.provider` again — a
  // second read here would reopen the same window one layer further down.
  switch (id) {
    case "openai-compatible":
      if (!config.baseUrl || !config.apiKey) {
        throw new Error("openai-compatible provider requires baseUrl and apiKey");
      }
      return new OpenAICompatibleAdapter(config.baseUrl, config.apiKey, model);
    case "anthropic":
      if (!config.apiKey) {
        throw new Error("anthropic provider requires apiKey");
      }
      return new AnthropicAdapter(config.apiKey, model);
    case "claude-code":
      return new ClaudeCodeAdapter(model, config.claudeCodePath);
    case "opencode":
      return new OpenCodeAdapter(model, config.opencodePath, config.sessionTitle);
    default:
      // Now genuinely redundant with the `Object.hasOwn` guard above, and kept
      // anyway: adding a provider to the union without a `case` here has to be
      // a loud failure rather than a silent fall-off returning `undefined`.
      throw new Error(`Unknown LLM provider: "${id}"`);
  }
}
