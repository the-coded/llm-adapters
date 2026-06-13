import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLLMAdapter } from "./factory.js";
import { PROVIDERS } from "./providers.js";
import type { LLMConfig } from "./types.js";

/** Every adapter, the same failure: whatever the provider says back echoes the
 *  API key, and the key must not come out in a stream `details` or in a thrown
 *  message.
 *
 *  One test across all adapters rather than one per adapter, because the
 *  per-adapter fix kept staying in the adapter where the defect was found: usage
 *  on `complete()`, redaction in the CLI adapters, the `??` on `opencodePath`,
 *  then the HTTP adapters registering the key and never applying the redactor
 *  to the response body. The table is keyed by the provider catalogue, so a new
 *  provider without a case here fails instead of being skipped.
 *
 *  POSIX-only for the CLI cases (`#!/bin/sh` fakes), like the adapter tests. */

// Not key-shaped on purpose: the secret guard scans versioned files and `dist/`,
// and redaction of a registered secret does not depend on its shape.
const KEY = "redaction-probe-8f3a1c9e2b7d4f60";

const dir = mkdtempSync(join(tmpdir(), "llm-adapters-redaction-"));
function fakeBin(name: string): string {
  const bin = join(dir, name);
  // Echoes the key on both streams and fails, for any arguments -- `opencode
  // serve` and `claude --print` alike.
  writeFileSync(bin, `#!/bin/sh\necho "auth failed, token ${KEY}"\necho "auth failed, token ${KEY}" >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A provider that answers 401 and echoes the credential header it was sent,
 *  which is what the gateway in the qa report did. */
function echoingFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const sent = headers.get("authorization") ?? headers.get("x-api-key") ?? "";
    return new Response(JSON.stringify({ error: { message: `invalid credentials, got: ${sent}` } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const CASES: Record<LLMConfig["provider"], { config: LLMConfig; http: boolean }> = {
  anthropic: { config: { provider: "anthropic", apiKey: KEY }, http: true },
  "openai-compatible": {
    config: { provider: "openai-compatible", baseUrl: "http://gateway.invalid/v1", apiKey: KEY, model: "m" },
    http: true,
  },
  "claude-code": { config: { provider: "claude-code", claudeCodePath: fakeBin("claude"), apiKey: KEY }, http: false },
  opencode: { config: { provider: "opencode", opencodePath: fakeBin("opencode"), model: "p/m", apiKey: KEY }, http: false },
};

test("every provider in the catalogue has a redaction case", () => {
  assert.deepEqual(Object.keys(CASES).sort(), Object.keys(PROVIDERS).sort());
});

for (const [provider, { config, http }] of Object.entries(CASES)) {
  test(`${provider}: an error that echoes the key does not return it`, async () => {
    const restore = http ? echoingFetch() : () => {};
    try {
      const adapter = getLLMAdapter(config);
      const messages = [{ role: "user" as const, content: "hi" }];

      const errors = [];
      for await (const chunk of adapter.stream("", messages)) if (chunk.type === "error") errors.push(chunk);
      // Vacuity guards: the failure has to happen, and the echo has to have
      // reached the output as the placeholder, or "the key is absent" proves
      // nothing about redaction.
      assert.equal(errors.length, 1, "stream() must report the failure");
      const streamed = JSON.stringify(errors);
      assert.ok(!streamed.includes(KEY), `stream() returned the key: ${streamed}`);
      assert.ok(streamed.includes("[redacted-secret]"), `stream() never carried the echo: ${streamed}`);

      const thrown = await adapter.complete("", messages).then(
        () => assert.fail("complete() must throw"),
        (err: Error) => err.message,
      );
      assert.ok(!thrown.includes(KEY), `complete() threw the key: ${thrown}`);
      assert.ok(thrown.includes("[redacted-secret]"), `complete() never carried the echo: ${thrown}`);
    } finally {
      restore();
    }
  });
}
