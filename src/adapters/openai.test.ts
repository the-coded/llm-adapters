import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleAdapter, readOpenAIUsage } from "./openai.js";
import type { LLMStreamChunk, LLMUsage } from "../types.js";

// Same as the anthropic suite: a stubbed round trip is all the suite can run,
// so the request is asserted as much as the answer.

type Call = { url: string; init: RequestInit | undefined };

function stubFetch(reply: (call: Call) => Response | Promise<Response>): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const sse = (...payloads: string[]) => payloads.map((p) => `data: ${p}\n\n`).join("");

async function drain(gen: AsyncGenerator<LLMStreamChunk>): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

test("stream sends the documented request and decodes content deltas", async () => {
  const stub = stubFetch(() =>
    new Response(
      sse(
        JSON.stringify({ choices: [{ delta: { content: "he" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "llo" } }] }),
        "[DONE]",
      ),
      { status: 200 },
    ),
  );
  try {
    const chunks = await drain(
      new OpenAICompatibleAdapter("https://openrouter.ai/api/v1", "secret-key", "some/model").stream("sys", [
        { role: "user", content: "hi" },
      ]),
    );

    const call = stub.calls[0]!;
    assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal((call.init!.headers as Record<string, string>).Authorization, "Bearer secret-key");
    const body = JSON.parse(String(call.init!.body)) as Record<string, unknown>;
    assert.equal(body.stream, true);
    // The system prompt is a message with `role: "system"` here, not a separate
    // field the way the Anthropic API takes it.
    assert.deepEqual(body.messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);

    assert.equal(chunks.filter((c) => c.type === "text").map((c) => c.text).join(""), "hello");
    assert.equal(chunks.at(-1)!.type, "done");
  } finally {
    stub.restore();
  }
});

// A trailing slash on a user-typed base URL is the common mistake, and doubling it
// into `//chat/completions` makes some gateways 404.
test("a trailing slash on the base URL does not become a doubled path separator", async () => {
  const stub = stubFetch(() => new Response(sse("[DONE]"), { status: 200 }));
  try {
    await drain(new OpenAICompatibleAdapter("https://x/v1/", "k", "m").stream("", []));
    assert.equal(stub.calls[0]!.url, "https://x/v1/chat/completions");
  } finally {
    stub.restore();
  }
});

test("an empty system prompt adds no system message", async () => {
  const stub = stubFetch(() => new Response(sse("[DONE]"), { status: 200 }));
  try {
    await drain(new OpenAICompatibleAdapter("https://x/v1", "k", "m").stream("", [{ role: "user", content: "q" }]));
    assert.deepEqual(JSON.parse(String(stub.calls[0]!.init!.body)).messages, [{ role: "user", content: "q" }]);
  } finally {
    stub.restore();
  }
});

test("a non-ok response becomes an error chunk carrying the body as details", async () => {
  const stub = stubFetch(() => new Response("nope", { status: 402 }));
  try {
    const chunks = await drain(new OpenAICompatibleAdapter("https://x/v1", "k", "m").stream("", []));
    assert.equal(chunks[0]!.type, "error");
    assert.match(chunks[0]!.error!, /402/);
    assert.equal(chunks[0]!.details, "nope");
  } finally {
    stub.restore();
  }
});

test("complete returns the first choice's content and honours a model override", async () => {
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { status: 200 }),
  );
  try {
    const text = await new OpenAICompatibleAdapter("https://x/v1", "k", "default-model").complete("", [], {
      model: "override-model",
    });
    assert.equal(text, "answer");
    assert.equal(JSON.parse(String(stub.calls[0]!.init!.body)).model, "override-model");
  } finally {
    stub.restore();
  }
});

test("complete throws on a non-ok response", async () => {
  const stub = stubFetch(() => new Response("bad key", { status: 401 }));
  try {
    await assert.rejects(() => new OpenAICompatibleAdapter("https://x/v1", "k", "m").complete("", []), /401/);
  } finally {
    stub.restore();
  }
});

test("listModels asks the configured endpoint and returns the ids", async () => {
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.5" }, { id: "anthropic/claude-opus-5" }] }), { status: 200 }),
  );
  try {
    const models = await new OpenAICompatibleAdapter("https://openrouter.ai/api/v1/", "k", "m").listModels();
    assert.deepEqual(models, ["openai/gpt-5.5", "anthropic/claude-opus-5"]);
    assert.equal(stub.calls[0]!.url, "https://openrouter.ai/api/v1/models");
  } finally {
    stub.restore();
  }
});

// Plenty of OpenAI-protocol gateways implement `/chat/completions` and nothing
// else. Discovery failing must never make the provider disappear from a
// caller's list — see docs/adr/0001, decision 3.
test("listModels returns [] on a gateway that does not implement /models", async () => {
  const stub = stubFetch(() => new Response("Not Found", { status: 404 }));
  try {
    assert.deepEqual(await new OpenAICompatibleAdapter("https://x/v1", "k", "m").listModels(), []);
  } finally {
    stub.restore();
  }
});

// The defect a real gateway found: `complete()` omitted `stream`, the 9router
// streams by default, and `res.json()` died on an SSE frame.
test("complete sends stream:false explicitly", async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), { status: 200 }));
  try {
    await new OpenAICompatibleAdapter("https://x/v1", "k", "m").complete("", []);
    assert.equal(JSON.parse(String(stub.calls[0]!.init!.body)).stream, false);
  } finally {
    stub.restore();
  }
});

test("a streamed response to complete is refused with an actionable error", async () => {
  const stub = stubFetch(() => new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    await assert.rejects(
      () => new OpenAICompatibleAdapter("https://x/v1", "k", "m").complete("", []),
      /streamed a response to a non-streaming request/,
    );
  } finally {
    stub.restore();
  }
});

test("complete reports the usage the endpoint returned", async () => {
  const stub = stubFetch(() =>
    new Response(
      JSON.stringify({
        model: "some/model",
        choices: [{ message: { content: "x" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } },
      }),
      { status: 200 },
    ),
  );
  try {
    const seen: LLMUsage[] = [];
    await new OpenAICompatibleAdapter("https://x/v1", "k", "m").complete("", [], { onUsage: (u) => seen.push(u) });
    assert.equal(seen.length, 1);
    // `prompt_tokens` includes the cached ones, so reporting both whole would
    // count the cache twice against the input on every cached call.
    assert.equal(seen[0]!.inputTokens, 100);
    assert.equal(seen[0]!.cacheReadTokens, 900);
    assert.equal(seen[0]!.outputTokens, 20);
    // The protocol has no cache-creation counter; absent is not zero.
    assert.equal(seen[0]!.cacheCreationTokens, null);
  } finally {
    stub.restore();
  }
});

// Gateways vary in how much they fill in, so each field is read on its own
// rather than trusting the object to be complete.
test("a usage object with no cache detail leaves the cache field unknown", () => {
  const usage = readOpenAIUsage({ prompt_tokens: 50, completion_tokens: 5 }, "m")!;
  assert.equal(usage.inputTokens, 50);
  assert.equal(usage.cacheReadTokens, null);
  assert.equal(readOpenAIUsage({}, "m"), null);
});

/** Same defect as the anthropic one, same direction: the usage was in the
 *  stream and never read. Without `stream_options.include_usage` the protocol
 *  sends none at all, so reading it opportunistically would have been a feature
 *  that never fires. */
test("stream asks for usage and reports it once", async () => {
  const stub = stubFetch(() =>
    new Response(
      sse(
        JSON.stringify({ model: "some/model", choices: [{ delta: { content: "hi" } }] }),
        // The usage chunk carries no choices, which is why it cannot be read
        // from the text path.
        JSON.stringify({ model: "some/model", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } }),
        "[DONE]",
      ),
      { status: 200 },
    ),
  );
  try {
    const seen: LLMUsage[] = [];
    await drain(new OpenAICompatibleAdapter("https://x/v1", "k", "m").stream("", [], { onUsage: (u) => seen.push(u) }));

    assert.deepEqual(JSON.parse(String(stub.calls[0]!.init!.body)).stream_options, { include_usage: true });
    assert.equal(seen.length, 1, `onUsage fired ${seen.length} times`);
    // prompt_tokens includes the cached ones, so reporting both whole would
    // count the cache twice against the input.
    assert.equal(seen[0]!.inputTokens, 100);
    assert.equal(seen[0]!.cacheReadTokens, 900);
    assert.equal(seen[0]!.outputTokens, 20);
    assert.equal(seen[0]!.costUSD, null);
  } finally {
    stub.restore();
  }
});

test("a stream carrying no usage reports nothing", async () => {
  const stub = stubFetch(() => new Response(sse(JSON.stringify({ choices: [{ delta: { content: "x" } }] }), "[DONE]"), { status: 200 }));
  try {
    let fired = 0;
    await drain(new OpenAICompatibleAdapter("https://x/v1", "k", "m").stream("", [], { onUsage: () => fired++ }));
    assert.equal(fired, 0);
  } finally {
    stub.restore();
  }
});

/** `max_tokens` only when set, on both paths; nothing by default, and nothing
 *  for a value that is not a positive integer. The reply is a 500, so the
 *  request is all this looks at. */
test("maxTokens is sent only when set and valid, on stream and complete", async () => {
  const stub = stubFetch(() => new Response("{}", { status: 500 }));
  const body = () => JSON.parse(String(stub.calls.at(-1)!.init!.body)) as Record<string, unknown>;
  try {
    const adapter = new OpenAICompatibleAdapter("http://gateway.test/v1", "key-for-tests-123", "m");
    const messages = [{ role: "user" as const, content: "hi" }];
    await drain(adapter.stream("", messages, { maxTokens: 256 }));
    assert.equal(body().max_tokens, 256);
    await adapter.complete("", messages, { maxTokens: 512 }).catch(() => {});
    assert.equal(body().max_tokens, 512);
    for (const unset of [undefined, 0, -1, 1.5, NaN, Infinity, 1e21]) {
      await drain(adapter.stream("", messages, { maxTokens: unset }));
      assert.ok(!("max_tokens" in body()), `stream sent max_tokens for ${unset}`);
      await adapter.complete("", messages, { maxTokens: unset }).catch(() => {});
      assert.ok(!("max_tokens" in body()), `complete sent max_tokens for ${unset}`);
    }
  } finally {
    stub.restore();
  }
});

test("an HTTP error chunk carries the status, with the old error text unchanged", async () => {
  const stub = stubFetch(() => new Response("slow down", { status: 429 }));
  try {
    const chunks = await drain(new OpenAICompatibleAdapter("http://gateway.test/v1", "key-for-tests-123", "m").stream("", [{ role: "user", content: "hi" }]));
    assert.deepEqual(chunks.map((c) => [c.type, c.error, c.status]), [["error", "request failed (429)", 429]]);
  } finally {
    stub.restore();
  }
});

test("a network failure gives an error chunk with no status key", async () => {
  const stub = stubFetch(() => Promise.reject(new TypeError("fetch failed")));
  try {
    const [chunk] = await drain(new OpenAICompatibleAdapter("http://gateway.test/v1", "key-for-tests-123", "m").stream("", [{ role: "user", content: "hi" }]));
    assert.equal(chunk!.type, "error");
    assert.ok(!("status" in chunk!), `status present: ${JSON.stringify(chunk)}`);
  } finally {
    stub.restore();
  }
});
