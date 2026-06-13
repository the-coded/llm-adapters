import type { LLMAdapter, LLMMessage, LLMStreamChunk, LLMUsage, StreamOptions } from "../types.js";
import { errorText, redactText, registerSecret } from "../redact.js";

/** Refuses a streamed body where a single JSON object was asked for.
 *
 *  `complete()` sends `stream: false`, but a server is free to ignore it -- and
 *  one that streams anyway feeds `res.json()` an SSE frame, which fails inside
 *  undici as `SyntaxError: Unexpected token 'd', "data: {"id"... is not valid
 *  JSON`. That names the symptom and nothing else: not the adapter, not the
 *  request, not the fact that the server disagreed about the protocol. Measured
 *  against a real gateway that streams by default, where this adapter's
 *  `complete()` had never once been run.
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
 * OpenAICompatibleAdapter — BYOK, plain `fetch` against any OpenAI-protocol
 * `/chat/completions` endpoint (OpenRouter, 9router, etc.). No `openai`
 * package — both request and streaming response are plain JSON/SSE.
 */
export class OpenAICompatibleAdapter implements LLMAdapter {
  readonly supportsFileTools = false;

  constructor(
    private baseUrl: string,
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
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: options?.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          // Without this the OpenAI protocol sends **no** usage in a stream at
          // all, so reading it opportunistically would be a feature that never
          // fires. Declared risk: a gateway that rejects unknown body fields
          // would fail the whole request rather than merely omit usage -- it is
          // a documented field of the protocol these endpoints implement, and
          // the ones measured so far accept it.
          stream_options: { include_usage: true },
          messages: [
            ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
            ...messages,
          ],
        }),
      });
    } catch (err) {
      yield { type: "error", error: errorText(err) };
      return;
    }

    if (!res.ok || !res.body) {
      yield { type: "error", error: `request failed (${res.status})`, details: await res.text().then(redactText, () => undefined) };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Usage arrives on a late chunk that carries no choices. Accumulated and
    // reported ONCE, on whichever path the call ends -- a truncated call still
    // consumed what it consumed.
    let streamUsage: Record<string, unknown> | undefined;
    let streamModel: string | undefined;
    let usageReported = false;
    const reportUsage = () => {
      if (usageReported) return;
      const usage = readOpenAIUsage(streamUsage, streamModel);
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
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              model?: string;
              choices?: { delta?: { content?: string } }[];
              usage?: Record<string, unknown>;
            };
            if (parsed.model) streamModel = parsed.model;
            if (parsed.usage) streamUsage = { ...(streamUsage ?? {}), ...parsed.usage };
            const text = parsed.choices?.[0]?.delta?.content;
            if (text) yield { type: "text", text };
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
    options?: { model?: string; signal?: AbortSignal; onUsage?: (usage: LLMUsage) => void }
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model ?? this.model,
        // Explicit, not omitted. Left out, the response shape depends on the
        // server's default -- and a local gateway that streams by default
        // returned SSE to this very call, which then died inside undici with a
        // SyntaxError naming none of that.
        stream: false,
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          ...messages,
        ],
      }),
      signal: options?.signal,
    });
    if (!res.ok) {
      throw new Error(`openai-compatible request failed (${res.status}): ${redactText(await res.text())}`);
    }
    assertNotStreamed(res, "openai-compatible");
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: Record<string, unknown>;
    };

    // The endpoint reports consumption on this response, so reporting it is
    // honest. Silence has to mean "the provider did not say", never "nobody
    // wired it up".
    const usage = readOpenAIUsage(data.usage, data.model);
    if (usage) options?.onUsage?.(usage);

    return data.choices?.[0]?.message?.content ?? "";
  }

  /** The models this endpoint serves, asked of the endpoint.
   *
   *  `[]` rather than a rejection on any failure — a gateway that does not
   *  implement `/models`, a bad key, no network. Discovery being unavailable
   *  must never make a provider disappear from a caller's list; the caller
   *  falls back to the static catalog in `providers.ts`. */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id?: string }[] };
      return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    } catch {
      return [];
    }
  }
}

/** Consumption from a non-streaming OpenAI-protocol response, or `null`.
 *
 *  `prompt_tokens` counts cached tokens too, so the cached figure is
 *  **subtracted** to get what was actually sent fresh -- reporting both whole
 *  would double-count the cache against the input on every cached call. Where
 *  the endpoint reports no cache detail at all, `cacheReadTokens` stays `null`
 *  rather than 0: unknown, not measured-as-none.
 *
 *  Gateways vary in how much of this they fill in, which is the reason each
 *  field is read independently instead of trusting the object to be complete. */
export function readOpenAIUsage(usage: Record<string, unknown> | undefined, model: string | undefined): LLMUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = details ? num(details.cached_tokens) : null;
  const prompt = num(usage.prompt_tokens);
  const input = prompt === null ? null : cached === null ? prompt : Math.max(0, prompt - cached);

  const out: LLMUsage = {
    model: model ?? null,
    models: model ? [model] : [],
    inputTokens: input,
    outputTokens: num(usage.completion_tokens),
    cacheReadTokens: cached,
    // The OpenAI protocol has no cache-creation counter; absent is not zero.
    cacheCreationTokens: null,
    costUSD: null,
    costBasis: null,
  };
  const anything = [out.inputTokens, out.outputTokens, out.cacheReadTokens].some((v) => v !== null);
  return anything ? out : null;
}
