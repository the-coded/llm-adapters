import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readStoredConfig, saveConfig } from "./config.js";
import { getLLMAdapter } from "./factory.js";
import { redactText } from "./redact.js";

/** Every test writes to a temp path. A config helper whose suite touches the
 *  real `~/.llm-adapters/config.json` would be a test that reads the machine it
 *  runs on, which is the whole thing this package refuses to do. */
const tmpConfig = () => join(mkdtempSync(join(tmpdir(), "llm-adapters-cfg-")), "config.json");

/** Clears the environment variables this helper reads, so a developer machine
 *  that exports `ANTHROPIC_API_KEY` does not silently change the result. */
function withoutEnv<T>(fn: () => T): T {
  const names = ["LLM_ADAPTERS_PROVIDER", "LLM_ADAPTERS_MODEL", "LLM_ADAPTERS_BASE_URL", "LLM_ADAPTERS_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  const saved = names.map((n) => [n, process.env[n]] as const);
  for (const n of names) delete process.env[n];
  try {
    return fn();
  } finally {
    for (const [n, v] of saved) if (v !== undefined) process.env[n] = v;
  }
}

test("nothing configured reads as null, not as an empty config", () => {
  withoutEnv(() => assert.equal(loadConfig({ path: tmpConfig() }), null));
});

// The defect that produced this shape, pinned: with a key saved for one
// provider, selecting another used to hand that key to the wrong vendor. The
// environment already distinguished; the file was the only part of the system
// that could not.
test("a key saved for one provider never reaches another", () => {
  const path = tmpConfig();
  saveConfig({ provider: "anthropic", apiKey: "anthropic-key-value" }, { includeApiKey: true, path });
  saveConfig({ provider: "openai-compatible", apiKey: "gateway-key-value", baseUrl: "http://localhost:1/v1" }, { includeApiKey: true, path });

  withoutEnv(() => {
    assert.equal(loadConfig({ provider: "anthropic", path })!.apiKey, "anthropic-key-value");
    assert.equal(loadConfig({ provider: "openai-compatible", path })!.apiKey, "gateway-key-value");
    // And a provider with no block gets no key at all rather than a sibling's.
    assert.equal(loadConfig({ provider: "opencode", path })!.apiKey, undefined);
  });
});

/** The merge is the load-bearing half of `saveConfig`. A naive write replaces
 *  the file and destroys every other provider's credentials silently — nobody
 *  finds out until they switch back to one of them. */
test("saving one provider does not wipe its siblings", () => {
  const path = tmpConfig();
  saveConfig({ provider: "anthropic", apiKey: "first-key-value", model: "claude-opus-5" }, { includeApiKey: true, path });
  saveConfig({ provider: "opencode", opencodePath: "/usr/local/bin/opencode" }, { includeApiKey: false, path });

  const stored = readStoredConfig({ path })!;
  assert.equal(stored.providers!.anthropic!.apiKey, "first-key-value");
  assert.equal(stored.providers!.anthropic!.model, "claude-opus-5");
  assert.equal(stored.providers!.opencode!.opencodePath, "/usr/local/bin/opencode");
  // The first provider written becomes the default; a later write does not
  // silently steal it.
  assert.equal(stored.default, "anthropic");
});

test("loadConfig with no argument resolves the default block", () => {
  const path = tmpConfig();
  saveConfig({ provider: "anthropic", model: "from-default-block" }, { includeApiKey: false, path });
  withoutEnv(() => {
    const config = loadConfig({ path })!;
    assert.equal(config.provider, "anthropic");
    assert.equal(config.model, "from-default-block");
  });
});

// Condition 4: writing a secret is a call somebody wrote on purpose. The common
// case here is claude-code and opencode, which use no key at all.
test("saveConfig drops the key unless the caller explicitly asks", () => {
  const path = tmpConfig();
  saveConfig({ provider: "anthropic", apiKey: "sekrit-value-1234", model: "m" }, { includeApiKey: false, path });

  const text = readFileSync(path, "utf8");
  assert.ok(!text.includes("sekrit-value-1234"), "the key was persisted without being asked for");
  assert.equal(readStoredConfig({ path })!.providers!.anthropic!.model, "m");
});

// Condition 1, the write half.
test("the file is written 0600 and the directory 0700", () => {
  const path = tmpConfig();
  saveConfig({ provider: "claude-code" }, { includeApiKey: false, path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
});

// Condition 1, the read half -- a throw rather than a warning, because a
// warning about a world-readable credential is one people scroll past.
test("a file readable by group or other is refused, loudly", () => {
  const path = tmpConfig();
  saveConfig({ provider: "anthropic", apiKey: "sekrit-value-1234" }, { includeApiKey: true, path });

  for (const mode of [0o640, 0o604, 0o644, 0o666]) {
    chmodSync(path, mode);
    assert.throws(() => loadConfig({ path }), /readable by group or other/, `mode ${mode.toString(8)} was accepted`);
  }

  chmodSync(path, 0o600);
  assert.equal(withoutEnv(() => loadConfig({ path })!).apiKey, "sekrit-value-1234");
});

/** Condition 2, and the part that had to become per provider: a vendor variable
 *  applies only to its own vendor. `ANTHROPIC_API_KEY` becoming an
 *  `openai-compatible` key because it happened to be exported is the same
 *  defect as the file's single `apiKey`, one layer over. */
test("environment beats the file, and a vendor variable stays with its vendor", () => {
  const path = tmpConfig();
  saveConfig({ provider: "anthropic", model: "from-file", apiKey: "file-key-value" }, { includeApiKey: true, path });
  saveConfig({ provider: "openai-compatible", apiKey: "gateway-key-value" }, { includeApiKey: true, path });

  withoutEnv(() => {
    process.env.LLM_ADAPTERS_MODEL = "from-env";
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";

    const anthropic = loadConfig({ provider: "anthropic", path })!;
    assert.equal(anthropic.model, "from-env");
    assert.equal(anthropic.apiKey, "env-anthropic-key");

    const gateway = loadConfig({ provider: "openai-compatible", path })!;
    assert.equal(gateway.apiKey, "gateway-key-value", "an ANTHROPIC_ variable leaked into another provider");
  });
});

// Condition 3: every key in the file, not only the selected provider's. Any of
// them can surface in an error, and registering just the active one would
// reopen the hole for the rest.
test("every key in the file is registered for redaction, not just the active one", () => {
  const path = tmpConfig();
  const anthropicKey = "sk" + "-ant-" + "api03-" + "Z".repeat(30);
  const gatewayKey = "sk" + "-" + "Y".repeat(40);
  saveConfig({ provider: "anthropic", apiKey: anthropicKey }, { includeApiKey: true, path });
  saveConfig({ provider: "openai-compatible", apiKey: gatewayKey }, { includeApiKey: true, path });

  // Resolve ONE of them; both must be scrubbed afterwards.
  withoutEnv(() => loadConfig({ provider: "anthropic", path }));

  for (const key of [anthropicKey, gatewayKey]) {
    assert.ok(!redactText(`request failed (401): bad key ${key}`).includes(key), "a sibling provider's key survived");
  }
});

/** A file in any shape but the documented one is refused, not read as empty.
 *  Read as empty, the next save rewrote it and the credentials it held were
 *  gone without a word -- so the save must refuse too, and leave every byte. */
test("an unknown top-level key refuses on load and on save, and the file is untouched", () => {
  const path = tmpConfig();
  const body = JSON.stringify({ provider: "anthropic", apiKey: "held-value-123456", model: "m" });
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  const unknownKey = /refusing to read .*unknown top-level key "provider"; expected "default" and "providers"/;

  withoutEnv(() => {
    assert.throws(() => loadConfig({ path }), unknownKey);
    assert.throws(() => readStoredConfig({ path }), unknownKey);
    assert.throws(
      () => saveConfig({ provider: "openai-compatible", baseUrl: "http://x/v1", apiKey: "new-value-abcdef" }, { includeApiKey: true, path }),
      unknownKey,
    );
  });
  assert.equal(readFileSync(path, "utf8"), body, "the save rewrote a file it refused to read");
});

test("unknown provider ids are still skipped, not refused", () => {
  const path = tmpConfig();
  writeFileSync(path, JSON.stringify({ providers: { "some-future-provider": { apiKey: "x" }, anthropic: { apiKey: "kept-value-1234" } } }), { mode: 0o600 });
  chmodSync(path, 0o600);
  withoutEnv(() => assert.deepEqual(readStoredConfig({ path }), { providers: { anthropic: { apiKey: "kept-value-1234" } } }));
});

test("malformed JSON, a BOM, and a file that is not a config all refuse actionably", () => {
  const cases: Array<[string, RegExp]> = [
    ["{ not json", /refusing to read .*not valid JSON/],
    ["\uFEFF{ still not json", /refusing to read .*not valid JSON/],
    ["[1,2,3]", /refusing to read .*expected a JSON object/],
    ['{"default":"nope"}', /refusing to read .*"default" is/],
    ['{"providers":{"anthropic":{"apiKey":42}}}', /refusing to read .*should be a string, found number/],
  ];
  for (const [body, expected] of cases) {
    const path = tmpConfig();
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.throws(() => withoutEnv(() => loadConfig({ path })), expected, `not refused actionably: ${body}`);
  }
});

test("a BOM in front of valid JSON is stripped, not rejected", () => {
  const path = tmpConfig();
  writeFileSync(path, '\uFEFF{"default":"opencode","providers":{"opencode":{}}}', { mode: 0o600 });
  chmodSync(path, 0o600);
  assert.equal(withoutEnv(() => loadConfig({ path })!).provider, "opencode");
});

// Unknown keys are dropped rather than refused: that is what lets a newer
// writer add a field without breaking an older reader.
test("an unrecognised field beside a recognised one is ignored", () => {
  const path = tmpConfig();
  writeFileSync(path, '{"default":"opencode","providers":{"opencode":{"model":"m","futureField":"x"}}}', { mode: 0o600 });
  chmodSync(path, 0o600);
  const config = withoutEnv(() => loadConfig({ path })!);
  assert.equal(config.model, "m");
  assert.ok(!("futureField" in config));
});

test("an empty environment variable falls back to the file", () => {
  const path = tmpConfig();
  saveConfig({ provider: "anthropic", model: "from-file" }, { includeApiKey: false, path });
  withoutEnv(() => {
    process.env.LLM_ADAPTERS_MODEL = "";
    assert.equal(loadConfig({ path })!.model, "from-file");
  });
});

/** The hole that reframed condition 3: registering the key only inside this
 *  helper protected the path nobody uses yet and left every existing consumer
 *  exactly as it was. Both consumers pass the key straight to `getLLMAdapter`. */
test("a key passed straight to getLLMAdapter is registered for redaction", () => {
  const key = "sk" + "-ant-" + "api03-" + "Q".repeat(30);
  getLLMAdapter({ provider: "anthropic", apiKey: key });
  const out = redactText(`anthropic request failed (401): invalid key ${key}`);
  assert.ok(!out.includes(key), "a directly-passed key was never registered");
  assert.ok(out.includes("request failed (401)"), "the useful part of the error was lost");
});
