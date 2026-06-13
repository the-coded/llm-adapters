import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCandidates, extractUsage, readCliOutput } from "./claude-code.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import type { LLMAdapter, LLMStreamChunk, LLMUsage } from "../types.js";

/** A REAL sample saved to disk, never a mock — this package's rule for anything
 *  that parses somebody else's output. Produced with
 *  `claude --print --output-format json` on 2026-06-13 and sanitized: only the
 *  `result` event, which is what the adapter reads, with `session_id` / `uuid`
 *  replaced. The `system` events were left out because they carry `cwd`,
 *  `memory_paths` and `messaging_socket_path` — machine paths, which do not
 *  belong in a repository. */
const FIXTURE = new URL("../fixtures/claude-code-result.json", import.meta.url);
const SAMPLE = JSON.parse(readFileSync(FIXTURE, "utf8")) as Array<Record<string, unknown>>;
const RESULT = SAMPLE.find((e) => e.type === "result")!;

test("extractUsage reads the consumption out of the real CLI sample", () => {
  const usage = extractUsage(RESULT)!;
  assert.notEqual(usage, null);
  assert.equal(usage.model, "claude-haiku-4-5-20251001");
  assert.deepEqual(usage.models, ["claude-haiku-4-5-20251001"]);
  assert.ok(usage.costUSD! > 0);
  // Cache kept separate from the rest: in the sample it is most of the
  // consumption, and it is the fact that vanishes if folded into input.
  assert.ok(usage.cacheCreationTokens! > usage.inputTokens!);
  assert.ok(usage.cacheReadTokens! > 0);
});

/** The decision the measurement forced, and why this test exists: `usage` and
 *  `modelUsage` DISAGREE in the real sample. `usage.input_tokens` says 10 and
 *  `modelUsage[...].inputTokens` says 908, because `usage` describes the call's
 *  last iteration (the object carries an `iterations` array) and `modelUsage`
 *  aggregates the whole call. Reading `usage` would under-report input by 90x —
 *  and an under-reported spending number is worse than an absent one, because
 *  it looks complete.
 *
 *  The test pins that choice against the sample: if someone switches the source
 *  to `usage`, it falls. */
test("tokens come from modelUsage, not usage -- the two disagree in the real sample", () => {
  const raw = RESULT.usage as unknown as Record<string, number>;
  const perModel = Object.values(RESULT.modelUsage as unknown as Record<string, Record<string, number>>)[0]!;

  // The premise: without the disagreement the assertion below is trivial, and
  // the day the CLI starts agreeing this test needs re-reading rather than
  // accidental passing.
  assert.notEqual(raw.input_tokens, perModel.inputTokens);

  const usage = extractUsage(RESULT)!;
  assert.equal(usage.inputTokens, perModel.inputTokens);
  assert.notEqual(usage.inputTokens, Number(raw.input_tokens));
});

// `null`, never 0: a silent provider cannot turn into "it cost zero" in a run's
// sum. Zero and unknown are the same in a sum and opposites in a spending
// decision.
test("no modelUsage means no usage: returns null instead of an invented zero", () => {
  assert.equal(extractUsage(undefined), null);
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage({ modelUsage: {} }), null);
  // Tokens present but the provider reported no dollar: usage exists, cost is null.
  const noDollar = extractUsage({ modelUsage: { m: { inputTokens: 10, outputTokens: 2 } } })!;
  assert.equal(noDollar.costUSD, null);
  assert.equal(noDollar.inputTokens, 10);
});

/** A total the provider stated is a fact it reported, and `modelUsage` being
 *  absent is no reason to throw it away — a spending decision turns on the
 *  dollar figure, not on the token breakdown. The fields that genuinely are
 *  unknown stay empty rather than being filled with a plausible zero. */
test("a bare total_cost_usd is reported even with no per-model breakdown", () => {
  const usage = extractUsage({ total_cost_usd: 0.42 })!;
  assert.notEqual(usage, null);
  assert.equal(usage.costUSD, 0.42);
  // Null, not 0, and null rather than "" for the model. The provider reported a
  // dollar and no breakdown, so both the tokens and the model are unknown --
  // and "zero and unknown are the same number in a sum" is the argument that
  // made `costUSD` nullable in the first place. An empty string is a value.
  assert.equal(usage.model, null);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.cacheReadTokens, null);
  assert.equal(usage.cacheCreationTokens, null);
  assert.deepEqual(usage.models, []);
  assert.equal(usage.costBasis, null);

  // And the silence case is untouched: no breakdown and no total is still null,
  // never a zero-filled call made to look complete.
  assert.equal(extractUsage({ modelUsage: {} }), null);
  assert.equal(extractUsage({ total_cost_usd: "free" as unknown as number }), null);
});

/** A negative dollar is not a refund this package knows how to read; it is a
 *  malformed number on its way into somebody's spend total. Treated as not
 *  reported, which is the same answer as for a missing one. */
test("a negative cost is refused rather than passed on", () => {
  assert.equal(extractUsage({ total_cost_usd: -5 }), null);

  // With a breakdown present, a negative total falls back to the per-model sum,
  // and negative per-model costs are refused there too.
  const usage = extractUsage({
    total_cost_usd: -5,
    modelUsage: { m: { inputTokens: 10, costUSD: -1 } },
  })!;
  assert.equal(usage.costUSD, null);
  assert.equal(usage.inputTokens, 10);
});

/** A field nobody reported is unknown, not zero -- even when other fields in
 *  the same call were reported. This is the half of the rule that is easy to
 *  lose: a partial breakdown must not silently complete itself. */
test("token fields nobody reported stay null, beside ones that were", () => {
  const usage = extractUsage({ modelUsage: { m: { inputTokens: 7, costUSD: 0.1 } } })!;
  assert.equal(usage.inputTokens, 7);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.cacheReadTokens, null);
  assert.equal(usage.cacheCreationTokens, null);
});

test("sums across models when the call used more than one, and keeps which ones", () => {
  const usage = extractUsage({
    total_cost_usd: 0.5,
    modelUsage: {
      "big-model": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 7, cacheCreationInputTokens: 3, costUSD: 0.4 },
      "small-model": { inputTokens: 10, outputTokens: 5, costUSD: 0.1 },
    },
  })!;
  assert.equal(usage.inputTokens, 110);
  assert.equal(usage.outputTokens, 55);
  assert.equal(usage.cacheReadTokens, 7);
  assert.equal(usage.model, "big-model"); // the dominant one
  assert.deepEqual(usage.models.sort(), ["big-model", "small-model"]);
  assert.equal(usage.costUSD, 0.5); // total_cost_usd wins when present
});

/** The seam between the extractor and the callback — and this test exists
 *  because the injection check **passed green** without it.
 *
 *  Consumer test doubles call `onUsage` themselves, and the extractor test
 *  measures the extractor in isolation: both halves covered, the wire between
 *  them not. Removing the callback fire inside the adapter brought nothing
 *  down. The fix was to MOVE the seam into a function a test can reach without
 *  a subprocess — not to add a test around the handler. */
test("readCliOutput fires onUsage with the real sample's consumption, and returns the text", () => {
  const stdout = readFileSync(FIXTURE, "utf8");
  const seen: Array<{ inputTokens: number | null; costUSD: number | null }> = [];

  const text = readCliOutput(stdout, (u) => seen.push({ inputTokens: u.inputTokens, costUSD: u.costUSD }));

  // Premise: the text still comes out right -- the seam must not have cost the
  // return value.
  assert.ok(text.length > 0);
  assert.equal(seen.length, 1); // fired ONCE
  assert.ok(seen[0]!.inputTokens! > 0);
  assert.ok(seen[0]!.costUSD! > 0);
});

// Output that is not the CLI's JSON invents no usage: it returns the raw text
// and does not call the callback. Silence means "I don't know".
test("output that is not the CLI's JSON returns the raw text and does NOT fire onUsage", () => {
  let fired = 0;
  const text = readCliOutput("this is not json", () => fired++);
  assert.equal(text, "this is not json");
  assert.equal(fired, 0);
});

// The dominant-model choice, against the shape measured on the real CLI: haiku
// with many tokens and cents, opus with two tokens and the whole cost.
test("extractUsage picks the model by cost when cost is known", () => {
  const usage = extractUsage({
    total_cost_usd: 0.3371115,
    modelUsage: {
      "claude-haiku-4-5-20251001": { inputTokens: 898, outputTokens: 9, costUSD: 0.000943 },
      "claude-opus-5": { inputTokens: 2, outputTokens: 4, costUSD: 0.3361685 },
    },
  })!;
  // Premise: haiku has MORE tokens -- without this the test does not cover the
  // trap, it merely confirms an ordering that already coincided.
  assert.ok(898 + 9 > 2 + 4);
  assert.equal(usage.model, "claude-opus-5");
  assert.deepEqual(usage.models.sort(), ["claude-haiku-4-5-20251001", "claude-opus-5"]);
});

// With no cost anywhere, it falls back to tokens -- the only ordering
// available, and there is no money to misattribute because `costUSD` is null.
test("with no cost reported, the dominant model falls back to tokens", () => {
  const usage = extractUsage({ modelUsage: { small: { inputTokens: 1 }, big: { inputTokens: 500 } } })!;
  assert.equal(usage.model, "big");
  assert.equal(usage.costUSD, null);
});

/** `stream()` firing `onUsage` — and this is an integration test through a real
 *  spawn, not a unit test around the parser.
 *
 *  It has to be. The usage channel already had two halves covered and the wire
 *  between them untested once before, which is the whole reason `readCliOutput`
 *  exists as a separate function. Here the seam is inside a closure in the spawn
 *  loop, so the only way to reach it is to actually spawn something — a stub
 *  binary replaying the captured `result` event as a `stream-json` line.
 *
 *  The event is the real sanitised fixture rather than a hand-built object, for
 *  the reason recorded further down this file: a flat-object test double once
 *  let a shape bug through while the suite stayed green. POSIX-only by
 *  construction, like the opencode discovery test. */
test("stream fires onUsage once, from the result event, with the real sample's numbers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapters-test-"));
  const bin = join(dir, "claude");
  const resultEvent = JSON.stringify(RESULT);
  // Two identical result lines on purpose: the contract is one report per call,
  // so a loop that fired per event would double a spend total here.
  writeFileSync(bin, `#!/bin/sh\ncat <<'OUT'\n${resultEvent}\n${resultEvent}\nOUT\n`);
  chmodSync(bin, 0o755);

  const seen: LLMUsage[] = [];
  const adapter = new ClaudeCodeAdapter("claude-opus-5", bin);
  const chunks: LLMStreamChunk[] = [];
  for await (const chunk of adapter.stream("sys", [{ role: "user", content: "hi" }], {
    onUsage: (u) => seen.push(u),
  })) {
    chunks.push(chunk);
  }

  assert.equal(seen.length, 1, "onUsage fired " + seen.length + " times, expected exactly 1");
  assert.equal(seen[0]!.model, "claude-haiku-4-5-20251001");
  assert.ok(seen[0]!.costUSD! > 0);
  assert.ok(seen[0]!.inputTokens! > 0);
  assert.equal(chunks.at(-1)!.type, "done");
});

/** The path qa found uncovered, and the one an invention would take: a `result`
 *  event that IS present and carries nothing extractable — no `modelUsage`, no
 *  `total_cost_usd`. The silence test below covers "no result event at all",
 *  which is a different branch: there, nothing reaches `extractUsage`. Here it
 *  does and returns `null`, and the adapter must report nothing rather than
 *  fire a zero-filled usage to look complete. ADR 0001 decision 4 forbids
 *  exactly that, and a guard that only covers the absent case would never see
 *  it. */
test("stream stays silent when the result event carries nothing extractable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapters-test-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\necho '{"type":"result","subtype":"success","result":"ok","is_error":false}'\n`);
  chmodSync(bin, 0o755);

  let fired = 0;
  const adapter = new ClaudeCodeAdapter("claude-opus-5", bin);
  const chunks: LLMStreamChunk[] = [];
  for await (const chunk of adapter.stream("", [], { onUsage: () => fired++ })) chunks.push(chunk);

  assert.equal(fired, 0, "a result event with no usage produced an invented report");
  assert.equal(chunks.at(-1)!.type, "done");
});

// A stream that carries no `result` event reports nothing either -- a different
// branch, where nothing reaches the extractor at all.
test("stream stays silent when the CLI reports no usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapters-test-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\necho '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'\n`);
  chmodSync(bin, 0o755);

  let fired = 0;
  const adapter = new ClaudeCodeAdapter("claude-opus-5", bin);
  for await (const _ of adapter.stream("", [], { onUsage: () => fired++ })) { /* drain */ }
  assert.equal(fired, 0);
});

// claude-code cannot ask its provider for a catalog, so it must OMIT the
// optional method rather than implement a static echo of `providers.ts`. This
// is what makes feature detection meaningful for a caller: a present
// `listModels` means the answer is live.
test("ClaudeCodeAdapter does not implement listModels at all", () => {
  // Typed as the interface on purpose: reading `.listModels` off the class
  // directly is a compile error, which is the static half of the same fact.
  const adapter: LLMAdapter = new ClaudeCodeAdapter("claude-opus-5");
  assert.equal(adapter.listModels, undefined);
});

/** The most serious leak of the batch, and it ran on **every failure**: the
 *  error chunk's `details` is built from raw stderr plus the last 30 lines of
 *  stdout, and those lines are the CLI's raw JSON events. The `result` event is
 *  the last line of every run, so it is always inside that window — and it
 *  carries `cwd`, `memory_paths`, `messaging_socket_path`, `session_id`, `uuid`
 *  and the home directory.
 *
 *  The committed fixture was sanitised with care because machine paths must
 *  never escape. The fixture is the copy nobody reads; this is the path that
 *  runs in production. Tested through a real spawn for that reason. */
test("a failing run's details carries no machine identifiers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapters-test-"));
  const bin = join(dir, "claude");
  const home = process.env.HOME ?? "/home/nobody";
  const user = process.env.USER ?? "nobody";
  const leaky = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "REAL-SESSION-a1b2",
    uuid: "REAL-UUID-c3d4",
    cwd: `${home}/projects/secret-project`,
    memory_paths: [`${home}/.claude/CLAUDE.md`],
    messaging_socket_path: "/tmp/cc-socks/71609.sock",
  });
  writeFileSync(bin, `#!/bin/sh\ncat <<'OUT'\n${leaky}\nOUT\necho "boom in ${home}/projects" >&2\nexit 3\n`);
  chmodSync(bin, 0o755);

  const chunks: LLMStreamChunk[] = [];
  for await (const chunk of new ClaudeCodeAdapter("claude-opus-5", bin).stream("", [])) chunks.push(chunk);

  const error = chunks.at(-1)!;
  assert.equal(error.type, "error");
  const details = error.details ?? "";

  // Still useful: the failure and its shape survive.
  assert.match(error.error!, /exited with code 3/);
  assert.ok(details.includes("boom in"), "the stderr text was scrubbed away with the paths");
  assert.ok(details.includes('"type":"result"'), "the event shape was lost");

  // None of the identifying VALUES reach the caller. The distinction matters:
  // a raw event is detected by the presence of keys like `cwd` and
  // `messaging_socket_path`, but the key name is not what identifies a machine
  // -- the value is. Redacting the value and keeping the key is what leaves
  // `details` useful, so the assertion is on values.
  for (const leak of [home, user, "REAL-SESSION-a1b2", "REAL-UUID-c3d4", "cc-socks", "/.claude/", "secret-project"]) {
    if (leak.length < 3) continue;
    assert.ok(!details.includes(leak), `details still leaks "${leak}"`);
  }

  // And every identifying key is present with its value gone, which is what
  // "the shape survives" has to mean if it means anything.
  for (const key of ["cwd", "memory_paths", "messaging_socket_path", "session_id", "uuid"]) {
    assert.match(details, new RegExp(`"${key}":(\\[)?"\\[redacted\\]"`), `${key} was not redacted in place`);
  }
});

/** The candidate list, and the defect it had: it carried
 *  `~/.nvm/versions/node/current/bin/claude`, and nvm creates no `current`
 *  symlink in a default install. The one entry that existed to cover the most
 *  common developer install was the one that could never match it — and the
 *  failure message then named four paths, none of them where an nvm user's
 *  binary is, at the moment somebody most needs a good hint. */
test("the candidate list expands real nvm versions and names no `current` alias", () => {
  const candidates = claudeCandidates();

  assert.ok(!candidates.some((c) => c.includes("/node/current/")), "the dead nvm `current` candidate is back");
  for (const fixed of ["/usr/local/bin/claude", "/opt/homebrew/bin/claude"]) {
    assert.ok(candidates.includes(fixed), `${fixed} is missing`);
  }

  // Where nvm is actually installed, every entry is a real version directory.
  const nvm = candidates.filter((c) => c.includes("/.nvm/versions/node/"));
  for (const entry of nvm) {
    assert.match(entry, /\/\.nvm\/versions\/node\/v[^/]+\/bin\/claude$/, `not a version path: ${entry}`);
  }
  if (nvm.length > 1) {
    // Newest first: a machine with several installed almost always wants the
    // newest, and an executable check follows anyway.
    const versions = nvm.map((c) => c.split("/node/")[1]!.split("/")[0]!);
    assert.deepEqual(versions, [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })));
  }
});

test("an absolute override leads the list, a relative one is ignored", () => {
  assert.equal(claudeCandidates("/custom/bin/claude")[0], "/custom/bin/claude");
  // A relative path would be resolved against the spawned process's cwd, which
  // is not the caller's -- so it is dropped rather than silently reinterpreted.
  assert.ok(!claudeCandidates("bin/claude").includes("bin/claude"));
});

/** `signal` has to kill what it says it kills.
 *
 *  `proc.kill()` signals the direct child alone, so a CLI that spawns anything
 *  of its own leaves grandchildren alive **holding the inherited stdout open** —
 *  the `close` event never fires and the call never resolves. Not a slow call, a
 *  hung one, which is the failure the deadline exists to prevent and cannot,
 *  because the problem is the signal's reach rather than its timing.
 *
 *  And it failed at exactly what `StreamOptions.signal`'s own comment promises:
 *  a client disconnect killing the spawned CLI instead of leaking it.
 *
 *  The test has its own timeout on purpose. Without one a regression would
 *  **hang** the suite rather than fail it, and a check that hangs tells you less
 *  than a check that goes red. */
test("aborting kills the CLI's children, not just the CLI", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapters-test-"));
  const bin = join(dir, "claude");
  const pidFile = join(dir, "grandchild.pid");
  // The background `sleep` inherits stdout; the foreground one keeps the shell
  // alive. Signalling only the shell leaves the first holding the pipe.
  writeFileSync(bin, `#!/bin/sh\nsleep 900 &\necho $! > ${pidFile}\nsleep 900\n`);
  chmodSync(bin, 0o755);

  const started = Date.now();
  const controller = new AbortController();

  // Aborts once the grandchild EXISTS, not after a fixed delay. The first
  // version slept 500ms and passed alone while failing in the full suite: under
  // parallel load the stub had not yet written its pid, so the test raced the
  // thing it was measuring. Waiting for the fact beats waiting for the clock.
  void (async () => {
    for (let i = 0; i < 200; i++) {
      if (existsSync(pidFile)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    controller.abort();
  })();

  const chunks: LLMStreamChunk[] = [];
  for await (const chunk of new ClaudeCodeAdapter("claude-opus-5", bin).stream("", [], { signal: controller.signal })) {
    chunks.push(chunk);
  }
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 15_000, `the stream took ${elapsed}ms to end after abort; it used to hang indefinitely`);

  // And the grandchild is actually gone, which is the half a timing assertion
  // cannot see: a stream that ended while the process survived would still leak.
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "the stub did not record a grandchild pid");
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `the grandchild ${pid} outlived the abort`);
  assert.ok(chunks.length >= 0);
});

/** An explicit path is an instruction. Falling back to a different binary when
 *  it does not work is the same defect class as a vendor key reaching another
 *  vendor: explicit configuration that silently does not apply.
 *
 *  Found the expensive way — a path that did not exist resolved through `which`
 *  and billed two real CLI runs to somebody who thought they were pointing at a
 *  stub. */
test("an explicit claudeCodePath that does not work fails instead of falling back", async () => {
  const missing = new ClaudeCodeAdapter("claude-opus-5", "/nonexistent/path/to/claude");
  const chunks: LLMStreamChunk[] = [];
  for await (const chunk of missing.stream("", [])) chunks.push(chunk);

  const error = chunks.at(-1)!;
  assert.equal(error.type, "error");
  assert.match(error.error!, /claudeCodePath points at/);
  assert.match(error.error!, /nonexistent\/path\/to\/claude/, "the message does not name the path that was asked for");
  // And it must not have reached the fallback, which is what cost real money.
  // Checked against the fallback error's own wording -- it lists the candidate
  // paths -- rather than against "which claude", which also appears in this
  // message's advice about how to opt back into that search.
  assert.ok(!/not at any of/.test(error.error!), "it fell through to the candidate search");

  await assert.rejects(() => missing.complete("", []), /claudeCodePath points at/);
});

// Both channels, one text: the stream chunk used `String(err)` and began with
// `Error: `, so the errors table's "Message begins" was only true for the
// throw. And the caller's own path is redacted too -- it is a home path, and an
// error is what gets logged.
test("a bad claudeCodePath reads the same on both channels, with the home path redacted", async () => {
  const underHome = join(homedir(), "no-such-dir", "claude");
  const adapter = new ClaudeCodeAdapter("m", underHome);
  const chunks: LLMStreamChunk[] = [];
  for await (const chunk of adapter.stream("", [])) chunks.push(chunk);
  const streamed = chunks.at(-1)!.error!;
  const thrown = await adapter.complete("", []).then(() => assert.fail("complete() must throw"), (err: Error) => err.message);

  assert.equal(streamed, thrown);
  assert.match(streamed, /^claudeCodePath points at "\[path\]"/);
  assert.ok(!streamed.includes(homedir()), `the home path leaked: ${streamed}`);
});

test("a relative claudeCodePath is refused rather than silently dropped", async () => {
  const chunks: LLMStreamChunk[] = [];
  for await (const chunk of new ClaudeCodeAdapter("m", "bin/claude").stream("", [])) chunks.push(chunk);
  assert.match(chunks.at(-1)!.error!, /must be an absolute path/);
});

// An empty string is set, not absent. Checked by truthiness it skipped the
// explicit-path branch and went to the fallback search, running whatever
// `which claude` found.
test("an empty claudeCodePath is refused rather than read as unset", async () => {
  const chunks: LLMStreamChunk[] = [];
  for await (const chunk of new ClaudeCodeAdapter("m", "").stream("", [])) chunks.push(chunk);
  assert.match(chunks.at(-1)!.error!, /must be an absolute path, got ""/);
});

// No override still uses the candidate list and `which`, which is the whole
// point of separating the two cases.
test("with no claudeCodePath the candidate search still runs", () => {
  const candidates = claudeCandidates();
  assert.ok(candidates.length > 2, "the candidate list collapsed");
  assert.ok(!candidates.some((c) => c.includes("nonexistent")));
});
