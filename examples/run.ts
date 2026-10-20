/**
 * The validation harness: one command per provider, against the real thing.
 *
 *   node examples/run.ts claude-code
 *   bun  examples/run.ts opencode
 *
 * It reads configuration through `loadConfig()`, which makes it the first real
 * consumer of that helper rather than a demonstration of it.
 *
 * Two properties matter more than what it prints:
 *
 * **Nothing here throws and nothing hangs.** A provider that is not set up says
 * what is missing and the process exits cleanly. A hang is worse than an
 * exception — an exception names a file and a line, while a hung process looks
 * like a slow network and costs somebody twenty minutes — so every call carries
 * a deadline.
 *
 * **The usage report states provenance.** `costUSD: null` prints as "not
 * reported by the provider", never as `0` and never as a missing line. That
 * distinction is the one the whole package exists to protect, and a demo that
 * erased it would contradict the library it demonstrates.
 */
import { getLLMAdapter, loadConfig, PROVIDERS, shutdown as stopProcesses } from "@the-coded/llm-adapters";
import type { LLMConfig, LLMUsage } from "@the-coded/llm-adapters";

/** Exit codes, because a harness that always exits 0 lies to whatever runs it.
 *
 *  `run.ts claude-code && echo ok` used to print `ok` after both calls had
 *  failed. Anyone chaining this in a script was told everything worked.
 *
 *  Not configured and configured-but-broken are different codes on purpose: it
 *  is the same distinction `loadConfig` draws between an absent file and a
 *  corrupt one, and a caller needs to tell "nobody set this up" from "this is
 *  set up and does not work". */
const EXIT = { ok: 0, misuse: 1, notConfigured: 2, failed: 3 } as const;

const TIMEOUT_MS = 60_000;
const SYSTEM = "Answer in at most six words. No preamble.";
const PROMPT = "Name three prime numbers.";

const IDS = Object.keys(PROVIDERS) as Array<LLMConfig["provider"]>;

function usage(): never {
  console.log("Usage: run.ts <provider>\n");
  console.log("Providers:");
  for (const id of IDS) console.log(`  ${id.padEnd(20)} ${PROVIDERS[id].description.split(".")[0]}`);
  console.log("\nConfiguration is read from ~/.llm-adapters/config.json and the environment.");
  console.log(`\nExit codes: ${EXIT.ok} ran, ${EXIT.misuse} wrong usage, ${EXIT.notConfigured} not configured, ${EXIT.failed} configured but failed.`);
  process.exit(EXIT.misuse);
}

/** What this provider needs and does not have, as a sentence rather than a
 *  throw. Only the credentials are checked here: a missing CLI binary is left
 *  to the adapter, whose own error names the paths it looked in. */
function missingRequirement(config: LLMConfig): string | null {
  if (config.provider === "anthropic" && !config.apiKey) {
    return "no API key. Set ANTHROPIC_API_KEY, or save one with saveConfig({ apiKey }, { includeApiKey: true }).";
  }
  if (config.provider === "openai-compatible") {
    if (!config.baseUrl) return "no base URL. Set LLM_ADAPTERS_BASE_URL to an OpenAI-protocol endpoint.";
    if (!config.apiKey) return "no API key. Set LLM_ADAPTERS_API_KEY or OPENAI_API_KEY.";
  }
  return null;
}

/** An adapter's message, minus the `Error: ` that `String(err)` prepends. The
 *  harness already says "failed", so repeating it reads like a stack trace
 *  leaking into a demo. */
function format(message: string | undefined, details?: string): string {
  const head = (message ?? "unknown failure").replace(/^Error:\s*/, "");
  return details ? `${head}\n  ${details}` : head;
}

function reportUsage(u: LLMUsage): void {
  const tokens = (label: string, value: number | null) =>
    `  ${label.padEnd(16)} ${value === null ? "not reported by the provider" : value}`;

  console.log("\nusage");
  console.log(`  ${"model".padEnd(16)} ${u.model ?? "not reported by the provider"}`);
  if (u.models.length > 1) console.log(`  ${"models".padEnd(16)} ${u.models.join(", ")}`);
  console.log(tokens("input", u.inputTokens));
  console.log(tokens("output", u.outputTokens));
  // Kept apart because the provider keeps them apart, and because on a real CLI
  // run they are the bulk of the bill.
  console.log(tokens("cache read", u.cacheReadTokens));
  console.log(tokens("cache creation", u.cacheCreationTokens));

  // The line this harness exists to print correctly. `null` is a statement, not
  // an absence, and it is never zero.
  if (u.costUSD === null) {
    console.log(`  ${"cost".padEnd(16)} not reported by the provider (unknown, not zero)`);
  } else {
    const basis = u.costBasis === null ? "basis not stated" : `basis: ${u.costBasis}`;
    console.log(`  ${"cost".padEnd(16)} $${u.costUSD} (${basis})`);
  }
}

async function main(): Promise<number> {
  const requested = process.argv[2];
  if (!requested || !IDS.includes(requested as LLMConfig["provider"])) usage();
  const provider = requested as LLMConfig["provider"];

  // The helper under test, not a stand-in for it. `loadConfig({ provider })`
  // resolves that provider's own block, so a key saved for one vendor is never
  // handed to another.
  const config: LLMConfig = loadConfig({ provider }) ?? { provider };

  console.log(`provider  ${provider}`);
  console.log(`model     ${config.model || PROVIDERS[provider].defaultModel}`);

  const missing = missingRequirement(config);
  if (missing) {
    console.log(`\nnot run: ${missing}`);
    return EXIT.notConfigured;
  }

  const adapter = getLLMAdapter(config);

  // Optional by design: a missing method means the provider cannot be asked at
  // all, and falling back to the catalogue is the caller's knowing choice.
  if (adapter.listModels) {
    const models = await adapter.listModels();
    console.log(`\nlistModels  ${models.length === 0 ? "none reachable (not installed, or not authenticated)" : `${models.length} available, e.g. ${models.slice(0, 3).join(", ")}`}`);
  } else {
    console.log(`\nlistModels  not implemented: this provider has no way to be asked`);
  }

  const seen: LLMUsage[] = [];
  const onUsage = (u: LLMUsage) => seen.push(u);

  console.log("\nstream");
  process.stdout.write("  ");
  let streamFailed: string | null = null;
  for await (const chunk of adapter.stream(SYSTEM, [{ role: "user", content: PROMPT }], {
    signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), shutdown.signal]),
    textOnly: true,
    onUsage,
  })) {
    if (chunk.type === "text") process.stdout.write(chunk.text ?? "");
    if (chunk.type === "error") streamFailed = format(chunk.error, chunk.details);
  }
  console.log();
  if (streamFailed) console.log(`  failed: ${streamFailed}`);

  console.log("\ncomplete");
  let completeFailed = false;
  try {
    const answer = await adapter.complete(SYSTEM, [{ role: "user", content: PROMPT }], {
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), shutdown.signal]),
      onUsage,
    });
    console.log(`  ${answer.trim()}`);
  } catch (err) {
    // Reported, not rethrown: one provider being unavailable is a result of
    // this run, not a crash of it.
    completeFailed = true;
    console.log(`  failed: ${format((err as Error).message)}`);
  }

  if (seen.length === 0) {
    console.log("\nusage\n  nothing reported. This provider did not say what the call consumed.");
  } else {
    for (const u of seen) reportUsage(u);
  }

  return streamFailed || completeFailed ? EXIT.failed : EXIT.ok;
}

/** Ctrl-C has to reach the spawned CLI, and since the group fix it does not on
 *  its own: `detached` takes the child out of the terminal's foreground group,
 *  so the interrupt arrives here and nowhere else. Without this handler the
 *  process dies by default action, no abort runs, and the child is left behind —
 *  the same leak the group fix closed, through the other door.
 *
 *  A library cannot install this: trapping SIGINT is an application deciding its
 *  own shutdown. So it lives with whoever owns the process, which is this file. */
const shutdown = new AbortController();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interrupted) process.exit(EXIT.failed); // a second one means get out now
    interrupted = true;
    console.log(`\n${signal} — cancelling the call and waiting for the process to go…`);
    shutdown.abort();
    // The abort propagates into the adapter, which kills the process group;
    // `stopProcesses()` then stops whatever the package still owns.
    void stopProcesses({ graceMs: 3_000 }).then(() => process.exit(EXIT.failed));
  });
}

// The code is set rather than the process killed, so anything still draining
// gets to finish. A harness that exits 0 after failing is worse than one that
// crashes: a crash is noticed.
process.exitCode = await main();
