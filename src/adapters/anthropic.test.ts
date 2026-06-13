import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicAdapter, readAnthropicUsage } from "./anthropic.js";
import type { LLMStreamChunk, LLMUsage } from "../types.js";

// A stubbed round trip is all the suite can run against this adapter, so these
// tests assert the request it builds as much as the answer it parses.

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

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function drain(gen: AsyncGenerator<LLMStreamChunk>): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

test("stream sends the documented request and decodes text deltas", async () => {
  const stub = stubFetch(() =>
    new Response(
      sse(
        { type: "content_block_delta", delta: { type: "text_delta", text: "he" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } },
      ),
      { status: 200 },
    ),
  );
  try {
    const chunks = await drain(new AnthropicAdapter("secret-key", "claude-opus-5").stream("sys", [
      { role: "user", content: "hi" },
    ]));

    const call = stub.calls[0]!;
    assert.equal(call.url, "https://api.anthropic.com/v1/messages");
    assert.equal(call.init!.method, "POST");
    const headers = call.init!.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "secret-key");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(String(call.init!.body)) as Record<string, unknown>;
    assert.equal(body.model, "claude-opus-5");
    assert.equal(body.stream, true);
    assert.equal(body.system, "sys");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);

    assert.equal(chunks.filter((c) => c.type === "text").map((c) => c.text).join(""), "hello");
    assert.equal(chunks.at(-1)!.type, "done");
  } finally {
    stub.restore();
  }
});

// A mid-stream API failure (overloaded, rate limited) arrives as an SSE error
// event. Without handling it the stream just ends as `done` and the turn looks
// like it completed normally — a wrong answer that reads as a right one.
test("an SSE error event becomes an error chunk, not a silent done", async () => {
  const stub = stubFetch(() =>
    new Response(sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 200 }),
  );
  try {
    const chunks = await drain(new AnthropicAdapter("k", "m").stream("", []));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.type, "error");
    assert.equal(chunks[0]!.error, "Overloaded");
    assert.equal(chunks[0]!.details, "overloaded_error");
  } finally {
    stub.restore();
  }
});

test("a non-ok response becomes an error chunk carrying the body as details", async () => {
  const stub = stubFetch(() => new Response("nope", { status: 401 }));
  try {
    const chunks = await drain(new AnthropicAdapter("k", "m").stream("", []));
    assert.equal(chunks[0]!.type, "error");
    assert.match(chunks[0]!.error!, /401/);
    assert.equal(chunks[0]!.details, "nope");
  } finally {
    stub.restore();
  }
});

test("complete returns the first text block and honours a per-call model override", async () => {
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ content: [{ type: "thinking" }, { type: "text", text: "answer" }] }), { status: 200 }),
  );
  try {
    const text = await new AnthropicAdapter("k", "default-model").complete("sys", [{ role: "user", content: "q" }], {
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
    await assert.rejects(() => new AnthropicAdapter("k", "m").complete("", []), /401/);
  } finally {
    stub.restore();
  }
});

test("listModels asks the API and returns the ids", async () => {
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }, {}] }), { status: 200 }),
  );
  try {
    const models = await new AnthropicAdapter("secret-key", "m").listModels();
    assert.deepEqual(models, ["claude-opus-5", "claude-sonnet-5"]);
    assert.equal(stub.calls[0]!.url, "https://api.anthropic.com/v1/models");
    assert.equal((stub.calls[0]!.init!.headers as Record<string, string>)["x-api-key"], "secret-key");
  } finally {
    stub.restore();
  }
});

// Discovery being unavailable must never make a provider disappear from a
// caller's list — `[]`, never a rejection. See docs/adr/0001, decision 3.
test("listModels returns [] rather than rejecting, on a bad status or a dead network", async () => {
  const refused = stubFetch(() => new Response("no", { status: 403 }));
  try {
    assert.deepEqual(await new AnthropicAdapter("k", "m").listModels(), []);
  } finally {
    refused.restore();
  }

  const offline = stubFetch(() => { throw new Error("ECONNREFUSED"); });
  try {
    assert.deepEqual(await new AnthropicAdapter("k", "m").listModels(), []);
  } finally {
    offline.restore();
  }
});

/** Found by running this adapter against a real gateway for the first time.
 *  `complete()` omitted `stream`, so the response shape depended on the
 *  server's default — and a server that streams by default fed `res.json()` an
 *  SSE frame, failing inside undici with a SyntaxError that named the symptom
 *  and nothing else. */
test("complete sends stream:false explicitly", async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ content: [{ type: "text", text: "x" }] }), { status: 200 }));
  try {
    await new AnthropicAdapter("k", "m").complete("", []);
    assert.equal(JSON.parse(String(stub.calls[0]!.init!.body)).stream, false);
  } finally {
    stub.restore();
  }
});

// And a server free to ignore it gets an error naming what happened, since that
// message is the only thing between somebody and an hour of looking in the
// wrong place.
test("a streamed response to complete is refused with an actionable error", async () => {
  const stub = stubFetch(() => new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    await assert.rejects(
      () => new AnthropicAdapter("k", "m").complete("", []),
      /streamed a response to a non-streaming request/,
    );
  } finally {
    stub.restore();
  }
});

/** The interface has always promised `onUsage` on `complete`; this adapter's
 *  options type was narrower and dropped it in silence. The same defect was
 *  found and fixed in `opencode` earlier and did not travel to its siblings. */
test("complete reports the usage the API returned", async () => {
  const stub = stubFetch(() =>
    new Response(
      JSON.stringify({
        model: "claude-opus-5",
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 900 },
      }),
      { status: 200 },
    ),
  );
  try {
    const seen: LLMUsage[] = [];
    await new AnthropicAdapter("k", "m").complete("", [], { onUsage: (u) => seen.push(u) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.model, "claude-opus-5");
    assert.equal(seen[0]!.inputTokens, 10);
    assert.equal(seen[0]!.cacheReadTokens, 900);
    // No dollars anywhere in the payload, so none are invented.
    assert.equal(seen[0]!.costUSD, null);
    // Absent is not zero: this response reported no cache creation.
    assert.equal(seen[0]!.cacheCreationTokens, null);
  } finally {
    stub.restore();
  }
});

test("a response with no usage fires nothing", () => {
  assert.equal(readAnthropicUsage(undefined, "m"), null);
  assert.equal(readAnthropicUsage({}, "m"), null);
});

/** The streaming-usage defect in its other direction: usage was read from
 *  `complete()` and not from `stream()`, while the data was in the stream the
 *  whole time. It is
 *  the failure that hides — a streaming consumer does not complain, it just
 *  never gets a number, and the README promised one. */
test("stream reports usage once, merging message_start and message_delta", async () => {
  const stub = stubFetch(() =>
    new Response(
      sse(
        { type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 25 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
        // The output count arrives late and must merge with, not replace, the
        // input and cache counts that came in `message_start`.
        { type: "message_delta", usage: { output_tokens: 7 } },
      ),
      { status: 200 },
    ),
  );
  try {
    const seen: LLMUsage[] = [];
    await drain(new AnthropicAdapter("k", "m").stream("", [], { onUsage: (u) => seen.push(u) }));

    assert.equal(seen.length, 1, `onUsage fired ${seen.length} times`);
    assert.equal(seen[0]!.model, "claude-opus-5");
    assert.equal(seen[0]!.inputTokens, 10);
    assert.equal(seen[0]!.outputTokens, 7);
    assert.equal(seen[0]!.cacheReadTokens, 900);
    assert.equal(seen[0]!.cacheCreationTokens, 25);
    assert.equal(seen[0]!.costUSD, null, "a price was invented; the API reports none");
  } finally {
    stub.restore();
  }
});

// A truncated call still consumed what it consumed. Withholding that is the
// mirror of inventing it.
test("stream still reports what it saw when the stream errors mid-way", async () => {
  const stub = stubFetch(() =>
    new Response(
      sse(
        { type: "message_start", message: { model: "m", usage: { input_tokens: 5 } } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ),
      { status: 200 },
    ),
  );
  try {
    const seen: LLMUsage[] = [];
    const chunks = await drain(new AnthropicAdapter("k", "m").stream("", [], { onUsage: (u) => seen.push(u) }));
    assert.equal(chunks.at(-1)!.type, "error");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.inputTokens, 5);
  } finally {
    stub.restore();
  }
});

test("a stream carrying no usage reports nothing", async () => {
  const stub = stubFetch(() => new Response(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }), { status: 200 }));
  try {
    let fired = 0;
    await drain(new AnthropicAdapter("k", "m").stream("", [], { onUsage: () => fired++ }));
    assert.equal(fired, 0);
  } finally {
    stub.restore();
  }
});
