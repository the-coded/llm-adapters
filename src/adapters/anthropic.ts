import type { LLMAdapter, LLMMessage, LLMStreamChunk, LLMUsage, StreamOptions } from "../types.js";
import { errorText, redactText, registerSecret } from "../redact.js";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
// Deliberately generous. A long answer — a whole source file plus surrounding
// prose — runs past a smaller ceiling and is truncated *silently*, so the
// caller sees a bad answer rather than an error and blames the prompt.
const MAX_TOKENS = 32000;

/** `maxTokens` as sent, or `undefined` when it is not a positive integer: an
 *  optional option must not become a new way for a call to fail. */
const validMaxTokens = (n: number | undefined): number | undefined =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;

/** Refuses a streamed body where a single JSON object was asked for.
 *
 *  `complete()` sends `stream: false`, but a server is free to ignore it — and
 *  one that streams anyway feeds `res.json()` an SSE frame, which fails inside
 *  undici as `SyntaxError: Unexpected token 'd', "data: {"id"... is not valid
 *  JSON`. That names the symptom and nothing else: not the adapter, not the
 *  request, not the fact that the server disagreed about the protocol. Measured
 *  against a real gateway that streams by default.
 *
 *  So the content type is checked before the parse, and the message says what
 *  happened rather than what it looked like. */
function assertNotStreamed(res: Response, provider: string): void {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    throw new Error(
      `${provider}: the server streamed a response to a non-streaming request (content-type: ${type}). ` +
        "It ignored `stream: false`; use `stream()` against this endpoint instead.",
    );
  }
}

/**
 * AnthropicAdapter — BYOK, plain `fetch` against the native Anthropic
 * Messages API. No `@anthropic-ai/sdk` — both request and streaming
 * response are plain JSON/SSE, matching this module's other adapters.
 */
export class AnthropicAdapter implements LLMAdapter {
  readonly supportsFileTools = false;

  constructor(
    private apiKey: string,
    private model: string
  ) {
    // Also registered at the constructor, not only in the factory: an adapter
    // can be built directly, and a key that reaches this class has reached the
    // library whichever door it came through.
    registerSecret(apiKey);
  }

  async *stream(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: StreamOptions
  ): AsyncGenerator<LLMStreamChunk> {
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        signal: options?.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: validMaxTokens(options?.maxTokens) ?? MAX_TOKENS,
          stream: true,
          system: systemPrompt || undefined,
          messages,
        }),
      });
    } catch (err) {
      yield { type: "error", error: errorText(err) };
      return;
    }

    if (!res.ok || !res.body) {
      yield {
        type: "error",
        error: `request failed (${res.status})`,
        details: await res.text().then(redactText, () => undefined),
        // Only for a non-ok answer: an ok response with no body is not an HTTP
        // error, and a 200 here would read as one.
        ...(res.ok ? {} : { status: res.status }),
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // The usage is in this stream and was being dropped. `message_start`
    // carries the input and cache counts plus the model; `message_delta`
    // carries the output count. Accumulated and reported ONCE, on whichever
    // path the call ends -- including a mid-stream error, because a truncated
    // call still consumed what it consumed, and withholding that is the mirror
    // of inventing it.
    let streamUsage: Record<string, unknown> = {};
    let streamModel: string | undefined;
    let usageReported = false;
    const reportUsage = () => {
      if (usageReported) return;
      const usage = readAnthropicUsage(streamUsage, streamModel);
      if (!usage) return;
      usageReported = true;
      options?.onUsage?.(usage);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          try {
            const parsed = JSON.parse(payload) as {
              type?: string;
              delta?: { type?: string; text?: string };
              error?: { type?: string; message?: string };
              message?: { model?: string; usage?: Record<string, unknown> };
              usage?: Record<string, unknown>;
            };
            if (parsed.type === "message_start") {
              streamModel = parsed.message?.model;
              streamUsage = { ...streamUsage, ...(parsed.message?.usage ?? {}) };
              continue;
            }
            if (parsed.type === "message_delta") {
              // Merged rather than replaced: the input and cache counts arrived
              // in `message_start` and are not repeated here.
              streamUsage = { ...streamUsage, ...(parsed.usage ?? {}) };
              continue;
            }
            if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
              yield { type: "text", text: parsed.delta.text ?? "" };
            } else if (parsed.type === "error") {
              // A mid-stream API failure (overloaded, rate limit) arrives as
              // an SSE error event; without this the stream just ends as
              // `done` and the turn looks like it completed normally.
              reportUsage();
              yield {
                type: "error",
                error: parsed.error?.message ?? "stream error",
                details: parsed.error?.type,
              };
              return;
            }
          } catch {
            // ignore non-JSON keep-alive lines
          }
        }
      }
    } catch (err) {
      reportUsage();
      yield { type: "error", error: errorText(err) };
      return;
    }
    reportUsage();
    yield { type: "done" };
  }

  async complete(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: { model?: string; signal?: AbortSignal; maxTokens?: number; onUsage?: (usage: LLMUsage) => void }
  ): Promise<string> {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: options?.model ?? this.model,
        max_tokens: validMaxTokens(options?.maxTokens) ?? MAX_TOKENS,
        // Explicit, not omitted. Left out, the response shape depends on the
        // server's default, and a gateway that streams by default returns SSE
        // to a call that is about to `.json()` it.
        stream: false,
        system: systemPrompt || undefined,
        messages,
      }),
      signal: options?.signal,
    });
    if (!res.ok) {
      throw new Error(`anthropic request failed (${res.status}): ${redactText(await res.text())}`);
    }
    assertNotStreamed(res, "anthropic");
    const data = (await res.json()) as {
      model?: string;
      content?: { type: string; text?: string }[];
      usage?: Record<string, unknown>;
    };

    // The API reports consumption on this response, so reporting it is honest
    // and staying silent would not be -- silence has to mean "the provider did
    // not say", never "nobody wired it up". No dollars anywhere in the payload,
    // so `costUSD` and `costBasis` stay null rather than being computed here.
    const usage = readAnthropicUsage(data.usage, data.model);
    if (usage) options?.onUsage?.(usage);

    return data.content?.find((b) => b.type === "text")?.text ?? "";
  }

  /** The models this key can reach, asked of the API.
   *
   *  `[]` rather than a rejection on any failure — a bad key, no network, an
   *  API that does not serve this endpoint. Discovery being unavailable must
   *  never make a provider disappear from a caller's list; the caller falls
   *  back to the static catalog in `providers.ts`. */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(ANTHROPIC_MODELS_URL, {
        headers: { "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id?: string }[] };
      return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    } catch {
      return [];
    }
  }
}

/** Consumption from a non-streaming Anthropic response, or `null`.
 *
 *  Exported-shaped as a free function for the reason `readCliOutput` is one: the
 *  seam is measurable without a network call. Fields the payload does not carry
 *  stay `null`, never 0 -- a call whose cache usage is unknown must not read as
 *  a call that used no cache. */
export function readAnthropicUsage(usage: Record<string, unknown> | undefined, model: string | undefined): LLMUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const out: LLMUsage = {
    model: model ?? null,
    models: model ? [model] : [],
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    costUSD: null,
    costBasis: null,
  };
  const anything = [out.inputTokens, out.outputTokens, out.cacheReadTokens, out.cacheCreationTokens].some((v) => v !== null);
  return anything ? out : null;
}
