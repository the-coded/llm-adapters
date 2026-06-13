import { test } from "node:test";
import assert from "node:assert/strict";
import { getLLMAdapter } from "./factory.js";
import { PROVIDERS } from "./providers.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { OpenAICompatibleAdapter } from "./adapters/openai.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";

test("each provider id builds its own adapter class", () => {
  assert.ok(getLLMAdapter({ provider: "claude-code" }) instanceof ClaudeCodeAdapter);
  assert.ok(getLLMAdapter({ provider: "opencode" }) instanceof OpenCodeAdapter);
  assert.ok(getLLMAdapter({ provider: "anthropic", apiKey: "k" }) instanceof AnthropicAdapter);
  assert.ok(
    getLLMAdapter({ provider: "openai-compatible", baseUrl: "https://x/v1", apiKey: "k" }) instanceof
      OpenAICompatibleAdapter,
  );
});

// The three documented refusals. Each one is a missing credential the adapter
// cannot invent, so failing here beats failing on the first request with a
// provider error that reads like the endpoint's fault.
test("the documented throw cases throw", () => {
  assert.throws(() => getLLMAdapter({ provider: "openai-compatible", apiKey: "k" }), /baseUrl/);
  assert.throws(() => getLLMAdapter({ provider: "openai-compatible", baseUrl: "https://x/v1" }), /apiKey/);
  assert.throws(() => getLLMAdapter({ provider: "anthropic" }), /apiKey/);
  assert.throws(
    // Deliberately outside the union — a caller reading a provider id out of
    // free-form configuration can reach this branch at runtime.
    () => getLLMAdapter({ provider: "nope" as never }),
    /Unknown LLM provider/,
  );
});

/** Inherited `Object.prototype` keys are the vectors a truthiness check waves
 *  through: `PROVIDERS` is an object literal, so `PROVIDERS["toString"]` is a
 *  truthy function and `if (!PROVIDERS[id])` never fires for any of these. They
 *  are reachable in practice because callers read the provider id out of
 *  free-form configuration — a JSON body, a settings file, a query string. */
test("prototype keys are refused like any other unknown provider", () => {
  for (const hostile of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
    assert.throws(
      () => getLLMAdapter({ provider: hostile as never }),
      /Unknown LLM provider/,
      `"${hostile}" was not refused`,
    );
  }
});

// An empty string is what an untouched free-text model field sends, and it must
// fall back to the default rather than travel to the provider as a model name.
test("an empty model falls back to the provider default, not to the empty string", () => {
  const withEmpty = getLLMAdapter({ provider: "anthropic", apiKey: "k", model: "" }) as unknown as {
    model: string;
  };
  assert.equal(withEmpty.model, PROVIDERS.anthropic.defaultModel);
});

// `sessionTitle` exists because the factory used to hardcode one consumer's
// name here. Absent, it must land on the package's own neutral default rather
// than on any application's name.
test("sessionTitle reaches the opencode adapter, and defaults without naming a consumer", () => {
  const named = getLLMAdapter({ provider: "opencode", sessionTitle: "my-app" }) as unknown as {
    sessionTitle: string;
  };
  assert.equal(named.sessionTitle, "my-app");

  const unnamed = getLLMAdapter({ provider: "opencode" }) as unknown as { sessionTitle: string };
  assert.equal(unnamed.sessionTitle, "llm-adapters");
});

// The catalog is typed by the provider union, so every branch the factory can
// take has an entry to read a default model from. A missing entry would be a
// `undefined.defaultModel` at runtime, which is why this is worth pinning.
test("every provider the factory accepts has a catalog entry", () => {
  for (const id of ["openai-compatible", "anthropic", "claude-code", "opencode"] as const) {
    assert.equal(PROVIDERS[id].id, id);
    assert.ok(PROVIDERS[id].defaultModel.length > 0);
  }
});
