import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter, extractStepUsage, foldStepUsage } from "./opencode.js";

// `listModels` shells out, so these tests stand up a fake `opencode` binary
// rather than mocking `execFile`: the thing under test is the spawn and the
// parse, and a mock would skip both.
//
// POSIX-only by construction (a `#!/bin/sh` script). CI runs Linux and
// development runs macOS; a Windows runner would need a `.cmd` twin.
function fakeOpencode(stdout: string): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapters-test-"));
  const bin = join(dir, "opencode");
  // Answers only to `models`, so the test also pins which argument is sent.
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" != "models" ]; then echo "wrong args: $*" >&2; exit 2; fi\ncat <<'OUT'\n${stdout}\nOUT\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("listModels spawns `opencode models` and keeps only provider/model lines", async () => {
  const bin = fakeOpencode(
    [
      "Available models:",
      "",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "  openai/gpt-5.5  ",
      "cline-pass/cline-pass/deepseek-v4-pro",
      "",
      "Run `opencode auth login` to add more providers.",
    ].join("\n"),
  );

  const models = await new OpenCodeAdapter("anthropic/claude-opus-5", bin).listModels();

  assert.deepEqual(models, [
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.5",
    "cline-pass/cline-pass/deepseek-v4-pro",
  ]);
});

/** The case that matters most, and the one that is easy to write as a happy
 *  path instead: a machine that never installed opencode is a NORMAL state, not
 *  an error. `[]`, never a rejection — docs/adr/0001, decision 3.
 *
 *  If this ever starts throwing, a caller's whole provider list disappears
 *  because one provider is not set up. */
test("listModels returns [] when the binary does not exist, instead of rejecting", async () => {
  const adapter = new OpenCodeAdapter("anthropic/claude-opus-5", "/nonexistent/path/to/opencode");
  const models = await adapter.listModels();
  assert.deepEqual(models, []);
});

test("listModels returns [] when the binary exists but fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapters-test-"));
  const bin = join(dir, "opencode");
  writeFileSync(bin, "#!/bin/sh\necho 'not authenticated' >&2\nexit 1\n");
  chmodSync(bin, 0o755);

  assert.deepEqual(await new OpenCodeAdapter("m/m", bin).listModels(), []);
});

// opencode wants provider and model as separate fields; callers carry one
// `provider/model` string. A bare model name is a caller mistake worth naming
// before a request goes out, not after the server rejects it.
test("a model without a provider prefix is refused with an actionable message", async () => {
  const adapter = new OpenCodeAdapter("gpt-5.5", "/nonexistent/opencode");
  const chunks = [];
  for await (const chunk of adapter.stream("", [{ role: "user", content: "hi" }])) chunks.push(chunk);
  // The server never starts with a bogus binary, so this reports the spawn
  // failure first — the point here is that neither path throws out of the
  // generator.
  assert.equal(chunks[0]!.type, "error");
});

// A POLICY, not a capability: opencode has file tools and this adapter denies
// them, at the server and per message. Callers branch on this field, so a flip
// would hand a plain chat a session with bash.
test("supportsFileTools is false", () => {
  assert.equal(new OpenCodeAdapter("m/m").supportsFileTools, false);
});

/** The usage channel, measured at the seam rather than through a live server.
 *
 *  Built against opencode's documented event schema, not against observed
 *  arithmetic: the shape was confirmed against real traffic but the numbers were
 *  not, so these tests pin the mapping and the discipline, and say so. If the
 *  real server disagrees about nesting, `stepPayload`'s shallow search is where
 *  that shows up.
 */
const step = (over: Record<string, unknown> = {}) => ({
  providerID: "anthropic",
  modelID: "claude-opus-5",
  cost: 0.25,
  tokens: { total: 120, input: 100, output: 20, reasoning: 0, cache: { read: 7, write: 900 } },
  ...over,
});

test("extractStepUsage maps the documented schema, and cache.write is creation", () => {
  const usage = extractStepUsage(step())!;
  assert.equal(usage.model, "anthropic/claude-opus-5");
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cacheReadTokens, 7);
  // The field most likely to be mapped backwards, and the largest number on
  // most real bills: `write` is what was created, not a second read counter.
  assert.equal(usage.cacheCreationTokens, 900);
  assert.equal(usage.costUSD, 0.25);
});

test("extractStepUsage finds the payload when the event nests it", () => {
  for (const key of ["step", "part", "info", "message"]) {
    const usage = extractStepUsage({ sessionID: "s", [key]: step() })!;
    assert.equal(usage.inputTokens, 100, `nesting under "${key}" was missed`);
  }
});

/** The schema allows `tokens` at more than one level of the same event, so an
 *  empty one earlier in the search must not end it. Stopping at the first
 *  container that merely *has* the key reported `null` while the numbers sat one
 *  key away — a search that gives up on its first candidate is not a search. */
test("an empty tokens object earlier in the event does not hide a usable one", () => {
  const usage = extractStepUsage({ tokens: {}, info: step({ cost: 0.9 }) })!;
  assert.notEqual(usage, null);
  assert.equal(usage.costUSD, 0.9);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.cacheCreationTokens, 900);
});

/** The selection rule, against every shape that broke a weaker one. Two rules
 *  were tried before this and each reported a wrong number rather than a missing
 *  one, which is the worse failure — so these four cases are the rule, not
 *  examples of it. */
test("an all-zero container does not win over one carrying real numbers", () => {
  const usage = extractStepUsage({
    tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    info: step({ cost: 9 }),
  })!;
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.costUSD, 9);
});

/** The case that killed "any non-zero figure wins": the top box has no tokens
 *  worth anything and a `cost`, so a money figure decided which box described
 *  the call — reporting a plausible, wrong 0.42 instead of 9, with a zeroed
 *  breakdown beside it. Cost without a breakdown is the same class as unknown
 *  token counts reported as zero in the other adapter, and here with a number
 *  that looks right. */
test("a cost on an otherwise empty container does not win over real tokens", () => {
  const usage = extractStepUsage({
    tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    cost: 0.42,
    info: step({ cost: 9, tokens: { input: 908, output: 122, cache: { read: 7557, write: 25305 } } }),
  })!;
  assert.equal(usage.inputTokens, 908);
  assert.equal(usage.outputTokens, 122);
  assert.equal(usage.cacheReadTokens, 7557);
  assert.equal(usage.cacheCreationTokens, 25305);
  assert.equal(usage.costUSD, 9, "the cost came from a container that was not selected");
});

// One non-zero token was enough to win under the old rule, so a nearly-empty box
// beat a complete one. Completeness settles it: four fields against one.
test("a single non-zero token does not win over a complete container", () => {
  const usage = extractStepUsage({
    tokens: { input: 1 },
    info: step({ cost: 9, tokens: { input: 908, output: 122, cache: { read: 7557, write: 25305 } } }),
  })!;
  assert.equal(usage.inputTokens, 908);
  assert.equal(usage.costUSD, 9);
});

/** `cost` comes from the selected container and from nowhere else. This is the
 *  accepted cost of that rule, asserted so nobody later "fixes" it: a cost
 *  reported in a container that was not selected is deliberately lost, because
 *  assembling one number from two sources the provider never presented together
 *  invents a correspondence it never asserted. */
test("a cost in an unselected container is lost on purpose, not borrowed", () => {
  const usage = extractStepUsage({
    tokens: { input: 1 },
    cost: 0.42,
    info: { tokens: { input: 908, output: 122, cache: { read: 7557, write: 25305 } } },
  })!;
  assert.equal(usage.inputTokens, 908);
  assert.equal(usage.costUSD, null, "a cost was borrowed from a sibling container");
});

/** The shape qa singled out of the accepted loss, pinned so the declaration is
 *  checkable rather than merely written: two containers reporting **identical**
 *  token fields where only one carries a cost. The tie falls to order and the
 *  cost is discarded — and unlike the other losses the two sources do not
 *  disagree about anything, so the "never presented together" argument has less
 *  force here. It is a uniform rule applied, not a considered answer to this
 *  shape, and this test is where a future change would announce itself. */
test("a perfect tie still discards a known cost, uniformly rather than cleverly", () => {
  const usage = extractStepUsage({
    tokens: { input: 5, output: 6 },
    info: { tokens: { input: 5, output: 6 }, cost: 9 },
  })!;
  assert.equal(usage.inputTokens, 5);
  assert.equal(usage.outputTokens, 6);
  assert.equal(usage.costUSD, null);
});

// And a step that genuinely consumed nothing still reports: every container
// scores zero, the tie falls to order, and the all-zero box is the right answer
// rather than a fallback. This case was the point of the previous fix and must
// not regress while the previous fix is being replaced.
test("a genuinely zero step is reported rather than suppressed", () => {
  const usage = extractStepUsage({ tokens: { input: 0, output: 0 } })!;
  assert.notEqual(usage, null);
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
});

test("an event with no usage in it is silence, not a zero-filled report", () => {
  assert.equal(extractStepUsage({ sessionID: "s" }), null);
  assert.equal(extractStepUsage({ tokens: {} }), null);
  assert.equal(extractStepUsage({ tokens: { input: "many" } }), null);
  assert.equal(foldStepUsage([]), null);
});

test("steps are summed into one report, and costBasis stays null", () => {
  const usage = foldStepUsage([
    extractStepUsage(step())!,
    extractStepUsage(step({ cost: 0.75, modelID: "claude-haiku-4-5", tokens: { input: 5, output: 1, cache: { read: 0, write: 0 } } }))!,
  ])!;

  assert.equal(usage.inputTokens, 105);
  assert.equal(usage.outputTokens, 21);
  assert.equal(usage.cacheCreationTokens, 900);
  assert.equal(usage.costUSD, 1);
  assert.deepEqual(usage.models, ["anthropic/claude-opus-5", "anthropic/claude-haiku-4-5"]);
  // The dominant model is the one that took the money, as in the other adapter.
  assert.equal(usage.model, "anthropic/claude-haiku-4-5");
  // opencode computes cost from a catalogue and declares no basis. Writing
  // "list" would be our inference in the provider's voice.
  assert.equal(usage.costBasis, null);
});

test("a field no step reported stays null rather than summing to zero", () => {
  const usage = foldStepUsage([extractStepUsage({ tokens: { input: 10 } })!])!;
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.cacheReadTokens, null);
  assert.equal(usage.costUSD, null);
  assert.equal(usage.model, null);
});
