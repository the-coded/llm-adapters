// opencode provider — talks to `opencode serve` over HTTP + SSE.
//
// WHY A SERVER AND NOT A SUBPROCESS PER TURN, which is what `claude-code.ts`
// does and what this adapter originally planned: recon on 2026-05-23 measured that `opencode run` cannot stream. Asked to
// count to 30, `--format json` emits three events — `step_start`, then `text`
// and `step_finish` together at the end — with the whole answer in one `text`.
// `--format default` is no better: all 30 lines land at once. There is no
// streaming flag on `run`.
//
// The server does stream: `GET /event` delivered 37 `message.part.delta`
// events for that same question. `LLMAdapter.stream()` exists to stream, so
// the server is not an optimisation here, it is the only way to honour the
// contract.
//
// The second reason is reproducibility, and it took a wrong turn worth writing
// down. Asked "what is my name", every isolation attempt kept answering with
// the name from the developer's personal rules — `--pure`,
// `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
// and the per-message `system` field. The variable looked broken.
//
// It was not: the same rule files were listed TWICE, once through
// `~/.claude/CLAUDE.md` and again in `opencode.json`'s `instructions[]`, and
// the variable only closes the first door. With the duplication removed the
// isolation holds — verified by asking the same question and getting "I don't
// know your name."
//
// The lesson is in the env below: this adapter sets the variable itself rather
// than trusting a machine to be configured right, because the failure is
// silent — an answer shaped by someone's personal rules looks exactly like an
// answer.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import type { LLMAdapter, LLMMessage, LLMStreamChunk, LLMUsage, StreamOptions } from "../types.js";
import { errorText, redactText, redactValue } from "../redact.js";
import { groupSpawnOptions, killProcessTree } from "../process-group.js";

const run = promisify(execFile);

/** How long to wait for a freshly spawned server to answer `/global/health`. */
const BOOT_TIMEOUT_MS = 30_000;
const BOOT_POLL_MS = 250;

/** One server per host process, started on first use.
 *
 * ponytail: module-scope process ownership — a library should not own a
 * subprocess in module scope, and this one does. It is correct for a single
 * long-running host process and wrong for a host that wants several
 * independently-disposable servers, or for a test that wants to tear one down.
 * Upgrade path: lift it into an explicitly-owned handle the caller creates and
 * disposes. Left as-is because every consumer today is the first shape, and
 * changing it is an API addition rather than a bug fix.
 *
 * The point of paying for a server at all is that it is paid once: a spawn per
 * turn would add its cold boot to every message, which is the cost `claude-code`
 * avoids by being a plain CLI. Kept module-level so every adapter instance and
 * every chat route share it. */
let shared: { proc: ChildProcess; base: string; ready: Promise<void> } | null = null;

function serverEnv(): NodeJS.ProcessEnv {
  return {
    // Deliberately narrow, same reasoning as claude-code's `spawnEnv`: the
    // server inherits nothing that could change an answer between machines.
    //
    // PATH is augmented with the two install dirs a spawned process often does
    // not inherit. HOME is required and not cosmetic: opencode's credentials
    // live in ~/.local/share/opencode/auth.json, so without it every turn
    // fails unauthenticated. NODE_ENV is passed through because the server and
    // its dependencies may branch on it, and leaving it unset is a different
    // environment from `"development"`.
    PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/opt/homebrew/bin`,
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    // Deny everything by default. The per-message `tools` field is what
    // actually takes tools away; this is the belt to that pair of braces, for
    // any code path that forgets to send it.
    OPENCODE_PERMISSION: JSON.stringify({ edit: "deny", bash: "deny", webfetch: "deny" }),
    // Keeps `~/.claude/` — CLAUDE.md, rules, skills — out of the answer, which
    // is what makes `textOnly` mean the same thing on every machine.
    //
    // Set even though a correctly-configured machine does not need it: the
    // isolation must not depend on someone's personal config staying clean.
    // It was exactly that dependency which hid the problem — the rules were
    // ALSO listed in `opencode.json`'s `instructions[]`, so they came in
    // through a second door this variable does not close, and the variable
    // looked broken when it was being bypassed.
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
  } as NodeJS.ProcessEnv;
}

async function ensureServer(binary: string): Promise<string> {
  if (shared) {
    await shared.ready;
    return shared.base;
  }

  // Port 0 asks the OS for a free one, but opencode prints its chosen port
  // rather than taking it as an argument in a readable way, so a fixed
  // high port keeps this simple. Collisions surface as a boot timeout with a
  // clear message rather than as silent cross-talk.
  const port = 47_300 + (process.pid % 200);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(binary, ["serve", "--port", String(port)], {
    env: serverEnv(),
    stdio: ["ignore", "ignore", "pipe"],
    // Outside the repository on purpose: opencode reads project-level config
    // and AGENTS.md from its working directory, and this adapter wants as
    // little of the machine in the answer as it can get. One source fewer,
    // alongside the env above.
    cwd: os.tmpdir(),
    // A group leader: `opencode serve` starts a server, so an orphan does not
    // merely linger -- it holds the port, and the next run finds a server that
    // is not its own.
    ...groupSpawnOptions,
  });

  let stderr = "";
  proc.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  // `spawn` reports a bad binary asynchronously, as an `error` event on the
  // child — NOT as a throw from `spawn` itself. Without this handler an
  // unreachable path (a mistyped `opencodePath`) is an unhandled event that
  // takes the whole host process down, which is a wrong answer to a wrong
  // setting. Recorded here so the boot loop below can report it as text.
  // An object rather than a plain binding: control-flow analysis narrows the
  // outer `let` to `never` at the read below, because the only assignment sits
  // in a callback it cannot see run. A property is not narrowed that way.
  const spawnFailure: { error: Error | null } = { error: null };
  proc.on("error", (err) => {
    spawnFailure.error = err;
  });

  const ready = (async () => {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnFailure.error) {
        shared = null;
        throw new Error(`could not run "${binary}": ${spawnFailure.error.message}`);
      }
      if (proc.exitCode !== null) {
        throw new Error(`opencode serve exited with ${proc.exitCode}: ${stderr.trim()}`);
      }
      try {
        const res = await fetch(`${base}/global/health`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
    }
    killProcessTree(proc, "SIGKILL");
    shared = null;
    throw new Error(
      `opencode serve did not answer on ${base} within ${BOOT_TIMEOUT_MS / 1000}s. ` +
        (stderr.trim() || "No stderr — is the port already taken?")
    );
  })();

  // A server that dies later must not leave a stale base URL behind, or every
  // subsequent turn fails against a port nobody is listening on.
  proc.on("exit", () => {
    if (shared?.proc === proc) shared = null;
  });

  // `unref` so a live server never keeps the process from exiting — the child
  // AND its stderr pipe, which is a live handle in its own right. Without both,
  // a script that finishes its stream sits there forever; found exactly that
  // way, with the first end-to-end test printing its whole answer and never
  // returning. The pipe is worth keeping (it carries the boot failure message),
  // so unref beats dropping it.
  proc.unref();
  // `Readable` has no `unref` in the types, but the stdio pipe underneath is a
  // socket that does — and it is a live handle either way.
  (proc.stderr as unknown as { unref?: () => void })?.unref?.();

  shared = { proc, base, ready };
  await ready;
  return base;
}

/** What one opencode step reported. Deliberately the same `null`-means-unknown
 *  discipline as `LLMUsage`: a field the event did not carry stays absent. */
export type OpenCodeStepUsage = {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUSD: number | null;
};

const numberOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The containers opencode uses for the step payload.
 *
 *  Resolved against the server's own schema rather than guessed from one
 *  traffic sample: `tokens` appears in six places across the document, and these
 *  five boxes cover all six.
 *
 *  **Declared limit — shapes the schema permits that these do not reach:** a
 *  `GlobalEvent` envelope, `props.parts[]` when it arrives as an array,
 *  two-level nestings such as `props.message.info.tokens`, and any container
 *  added later. The search stays shallow on purpose: a recursive hunt for any
 *  `tokens` key anywhere would start finding things that are not this, and a
 *  wrong number is worse than a missing one in a spend total. */
const STEP_CONTAINERS = ["step", "part", "info", "message", "usage"] as const;

/** Reads one candidate container, or `null` if it carries nothing usable. */
function readPayload(payload: Record<string, unknown>): OpenCodeStepUsage | null {
  const tokens = payload.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") return null;
  const cache = tokens.cache as Record<string, unknown> | undefined;

  const providerID = typeof payload.providerID === "string" ? payload.providerID : null;
  const modelID = typeof payload.modelID === "string" ? payload.modelID : null;
  // Composed `provider/model`, which is the form this adapter takes and the form
  // `opencode models` prints -- a bare model id would not round-trip.
  const model = modelID ? (providerID ? `${providerID}/${modelID}` : modelID) : null;

  const usage: OpenCodeStepUsage = {
    model,
    inputTokens: numberOrNull(tokens.input),
    outputTokens: numberOrNull(tokens.output),
    cacheReadTokens: cache ? numberOrNull(cache.read) : null,
    cacheCreationTokens: cache ? numberOrNull(cache.write) : null,
    costUSD: numberOrNull(payload.cost),
  };

  // A container that had a `tokens` object but nothing readable in it is
  // silence, not a zero-filled report.
  return Object.values(usage).some((v) => v !== null) ? usage : null;
}

/** One step's consumption, or `null` when the event carries none.
 *
 *  Exported so it can be measured directly. The seam between "an event arrived"
 *  and "a number reached the caller" is otherwise buried inside the SSE loop,
 *  which is the same trap `readCliOutput` exists to avoid in the other adapter.
 *
 *  The schema allows `tokens` at more than one level of the same event, so
 *  `{ tokens: {}, info: { tokens: <the numbers> } }` is a legal shape and the
 *  event has to be searched rather than sampled.
 *
 *  **Selection is by COMPLETENESS: the container reporting the most non-zero
 *  token fields wins, and a tie goes to the earlier entry in
 *  `STEP_CONTAINERS`.** Two weaker rules were tried and both produced a wrong
 *  number rather than a missing one, which is the worse failure:
 *
 *  - *First container that parses* let an all-zero `tokens` at the top of the
 *    event end the search while the real figures sat in `info`. A zero is
 *    readable, so it "worked" -- and a zero in a spend total is precisely what
 *    ADR 0001 decision 4 exists to prevent, reproduced inside the code written
 *    to honour it.
 *  - *First container with any non-zero figure* was worse. A top-level box
 *    carrying only `cost: 0.42` beat a nested one carrying real tokens and
 *    `cost: 9`, reporting **a plausible, wrong amount of money** with a zeroed
 *    breakdown beside it. One non-zero token was enough to win too, so
 *    `{input: 1}` beat a complete box.
 *
 *  Counting non-zero token fields settles all of them: four against zero, four
 *  against one. `cost` is deliberately **not** part of the count -- letting a
 *  money figure decide which box describes the call is what produced the wrong
 *  amount.
 *
 *  A step that genuinely consumed nothing still reports zero: every container
 *  then scores zero, the tie falls to order, and the all-zero box is the right
 *  answer rather than a fallback.
 *
 *  **`cost` comes from the selected container and from nowhere else.** If the
 *  selected box reports no cost, `costUSD` is `null` -- unknown, not borrowed
 *  from a sibling. The cost of that is real and accepted: a cost reported in a
 *  container this did not select is **deliberately lost**. Assembling one number
 *  from two sources the provider never presented together invents a
 *  correspondence it never asserted, which is decision 4 applied to where a
 *  figure comes from and not only to whether it exists.
 *
 *  **One shape inside that loss is worth naming separately, because the argument
 *  for it is weaker there.** When two containers report *identical* token
 *  fields and only one carries a cost, the tie falls to order and the cost is
 *  discarded — yet the two sources do not disagree about anything, so "the
 *  provider never presented them together" has much less force than it does when
 *  the boxes differ. It is still discarded today, and that is a deliberate
 *  uniform rule rather than a considered answer to this particular shape. If it
 *  ever needs revisiting, this is the case to revisit, not the general one.
 *
 *  **`cache.write` is the creation count**, and maps to `cacheCreationTokens` --
 *  not to a second read counter. Getting that backwards would put the largest
 *  number on most real bills in the wrong field. */
export function extractStepUsage(props: Record<string, unknown>): OpenCodeStepUsage | null {
  const candidates: unknown[] = [props, ...STEP_CONTAINERS.map((k) => props[k])];
  const usable: OpenCodeStepUsage[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const usage = readPayload(candidate as Record<string, unknown>);
    if (usage) usable.push(usage);
  }
  if (usable.length === 0) return null;

  // Non-zero TOKEN fields only. `cost` is excluded on purpose -- see above.
  const score = (u: OpenCodeStepUsage) =>
    [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheCreationTokens].filter((v) => v !== null && v !== 0).length;

  let best = usable[0]!;
  let bestScore = score(best);
  for (const candidate of usable.slice(1)) {
    const candidateScore = score(candidate);
    // Strictly greater, so a tie keeps the earlier container -- the declared
    // per-step-beats-session-aggregate preference.
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

/** Folds every step of one call into a single `LLMUsage`, or `null`.
 *
 *  **One report per provider invocation, not one per step.** A session can emit
 *  several steps and both carrier events can arrive for the same one, so the
 *  steps are summed and reported once at the end of the call. Fields nobody
 *  reported stay `null` rather than summing to a confident zero.
 *
 *  `costBasis` is always `null`: opencode computes cost from a catalogue price
 *  table and never declares a basis, so writing `"list"` would be our inference
 *  wearing the provider's voice -- the same defect as a zero standing in for
 *  unknown, with better disguise. */
export function foldStepUsage(steps: readonly OpenCodeStepUsage[]): LLMUsage | null {
  if (steps.length === 0) return null;

  const sum = (key: Exclude<keyof OpenCodeStepUsage, "model">): number | null => {
    let total: number | null = null;
    for (const s of steps) {
      const v = s[key];
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };

  const models = [...new Set(steps.map((s) => s.model).filter((m): m is string => m !== null))];
  // The dominant model is the one that took the money, matching the other
  // adapter; with no cost anywhere there is no money to misattribute, so the
  // first named model stands in.
  let model: string | null = models[0] ?? null;
  let best = -1;
  for (const s of steps) {
    if (s.model !== null && s.costUSD !== null && s.costUSD > best) {
      best = s.costUSD;
      model = s.model;
    }
  }

  return {
    model,
    models,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
    costUSD: sum("costUSD"),
    costBasis: null,
  };
}

export class OpenCodeAdapter implements LLMAdapter {
  // A POLICY, not a capability — the distinction matters and this field cannot
  // express both. opencode HAS file tools; this adapter denies them, at the
  // server (`OPENCODE_PERMISSION`) and per message (`tools: {}`).
  //
  // False rather than true because callers read this to decide how to drive
  // the provider (`adapter.supportsFileTools` → cwd, maxTurns, textOnly).
  // Flipping it would hand a plain chat — which sets no `textOnly` — a session
  // with bash on a server that is already up. The denial lives in server-level
  // env, shared across calls, so it cannot vary per request the way
  // claude-code's flags do.
  //
  // ponytail: policy reported as capability. Making the denial a constructor
  // option would let this state the capability truthfully. Not done here
  // because it widens the public contract, which is a decision rather than a
  // cleanup.
  readonly supportsFileTools = false;

  private model: string;
  private binary: string;
  private sessionTitle: string;

  constructor(model: string, customPath?: string, sessionTitle = "llm-adapters") {
    this.model = model;
    // `??` rather than `||` for the same reason the factory uses `||` for the
    // model and this does not: an empty string here is not "use the default",
    // it is a caller passing something broken, and turning it into "opencode"
    // would be an explicit setting silently not applying. An empty string
    // reaches `spawn`, which fails naming it.
    this.binary = customPath ?? "opencode";
    this.sessionTitle = sessionTitle;
  }

  /** opencode wants the provider and the model as separate fields, while
   * callers keep one `provider/model` string — the form `opencode models`
   * prints and the form a user pastes. */
  private splitModel(): { providerID: string; modelID: string } {
    const slash = this.model.indexOf("/");
    if (slash < 0) {
      throw new Error(
        `opencode model must be "provider/model" (got "${this.model}") — run \`opencode models\` for the list`
      );
    }
    return {
      providerID: this.model.slice(0, slash),
      modelID: this.model.slice(slash + 1),
    };
  }

  /** The conversation as one prompt.
   *
   * A session per turn, rather than one long server-side session, because the
   * caller already owns the history: it passes the full `messages` every time,
   * and letting the server keep its own would mean two sources of truth for
   * what was said. */
  private buildPrompt(messages: LLMMessage[]): string {
    return messages
      .map((m) => (m.role === "user" ? m.content : `Assistant: ${m.content}`))
      .join("\n\n");
  }

  private async post(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  async *stream(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: StreamOptions
  ): AsyncGenerator<LLMStreamChunk> {
    // An already-aborted signal must not start a server. Same reason as the
    // other adapter: an abort that already happened never fires a listener, so
    // this would spawn something nothing would kill -- and here that something
    // is a server holding a port.
    if (options?.signal?.aborted) {
      yield { type: "error", error: "aborted before the server was started" };
      return;
    }

    let base: string;
    try {
      base = await ensureServer(this.binary);
    } catch (err) {
      // The message of a spawn failure carries the binary path, which is a
      // machine path whenever `opencodePath` is an absolute override.
      yield { type: "error", error: "opencode server failed to start", details: errorText(err) };
      return;
    }

    const model = this.splitModel();
    let sessionId = "";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    // Steps are collected and reported ONCE, at whichever terminal path the call
    // takes. Both carrier events can arrive for the same step and a session can
    // run several, so reporting per event would multiply somebody's spend total.
    const steps: OpenCodeStepUsage[] = [];
    let usageReported = false;
    const reportUsage = () => {
      if (usageReported) return;
      const usage = foldStepUsage(steps);
      if (!usage) return; // nothing reported is silence, never a zero-filled call
      usageReported = true;
      options?.onUsage?.(usage);
    };

    try {
      const created = await this.post(base, "/session", { title: this.sessionTitle });
      if (!created.ok) throw new Error(`POST /session -> ${created.status}`);
      sessionId = ((await created.json()) as { id: string }).id;

      // Subscribe BEFORE prompting, or the first deltas are lost — the stream
      // carries what happens after you attach, not a replay.
      const events = await fetch(`${base}/event`, { signal: options?.signal });
      if (!events.ok || !events.body) throw new Error(`GET /event -> ${events.status}`);

      const sent = await this.post(base, `/session/${sessionId}/prompt_async`, {
        model,
        // The two fields that make this reproducible — see the file header.
        system: systemPrompt,
        tools: options?.textOnly === false ? undefined : {},
        parts: [{ type: "text", text: this.buildPrompt(messages) }],
      });
      if (!sent.ok && sent.status !== 204) {
        throw new Error(`prompt_async -> ${sent.status} ${(await sent.text()).slice(0, 300)}`);
      }

      reader = events.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawText = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a frame's payload lines
        // start with `data:`.
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data) continue;

          let event: { type?: string; properties?: Record<string, unknown> };
          try {
            event = JSON.parse(data);
          } catch {
            continue; // a heartbeat or a frame we do not model
          }
          const props = event.properties ?? {};
          if (props.sessionID && props.sessionID !== sessionId) continue;

          if (event.type === "session.next.step.ended" || event.type === "step-finish") {
            // The consumption channel. Both event names carry it, which is why
            // these are accumulated rather than reported here.
            const step = extractStepUsage(props);
            if (step) steps.push(step);
            continue;
          }

          if (event.type === "message.part.delta" && props.field === "text") {
            sawText = true;
            yield { type: "text", text: String(props.delta ?? "") };
          } else if (event.type === "session.idle") {
            reportUsage();
            yield { type: "done" };
            return;
          } else if (event.type === "session.error") {
            reportUsage();
            yield {
              type: "error",
              error: "opencode reported an error",
              // Redacted, not raw: these events carry absolute machine paths,
              // and an error's `details` is the field most likely to be logged
              // or pasted into an issue.
              details: redactText(JSON.stringify(redactValue(props))).slice(0, 500),
            };
            return;
          }
        }
      }

      // The stream ended without `session.idle`. Saying so beats yielding
      // `done` and letting the caller believe it saw a complete answer. What the
      // provider did report about consumption is still reported: a truncated
      // call still cost money, and withholding it would be the mirror of
      // inventing a zero.
      reportUsage();
      yield sawText
        ? { type: "done" }
        : { type: "error", error: "opencode closed the event stream without answering" };
    } catch (err) {
      if (options?.signal?.aborted) {
        // The client hung up. Tell the server, or it keeps burning tokens on
        // an answer nobody will read.
        if (sessionId) void this.post(base, `/session/${sessionId}/abort`, {});
        reportUsage();
        yield { type: "done" };
        return;
      }
      reportUsage();
      yield { type: "error", error: "opencode request failed", details: errorText(err) };
    } finally {
      // Every exit path closes the stream — including the consumer breaking out
      // of the `for await`, which runs this and nothing else. Leaving it open
      // holds the event loop: the first end-to-end test printed its whole
      // answer and then never returned, because an undici response body counts
      // as a live handle.
      await reader?.cancel().catch(() => {});
    }
  }

  async complete(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: { model?: string; signal?: AbortSignal; onUsage?: (usage: LLMUsage) => void }
  ): Promise<string> {
    // Same path as `stream`, drained. The server has a blocking
    // `POST /session/:id/message`, but using it would mean two code paths that
    // can disagree about permissions, tools and error shape.
    const previous = this.model;
    if (options?.model) this.model = options.model;
    try {
      let out = "";
      // `stream()` already honours `signal` -- it was just never forwarded
      // from here (this method dropped `options` entirely on the call below).
      for await (const chunk of this.stream(systemPrompt, messages, { signal: options?.signal, onUsage: options?.onUsage })) {
        if (chunk.type === "text") out += chunk.text ?? "";
        // Joined with a separator: concatenated bare, the two ran together as
        // "opencode server failed to startError: could not run ...", which is
        // the kind of thing only a real run surfaces.
        if (chunk.type === "error") throw new Error([chunk.error, chunk.details].filter(Boolean).join(": "));
      }
      return out;
    } finally {
      this.model = previous;
    }
  }

  /** The models this install can actually reach, asked of the CLI.
   *
   *  Read from the CLI rather than hardcoded because there is no fixed catalog
   *  to hardcode: opencode's models depend on which providers the user
   *  authenticated with `opencode auth login`, so the same build offers a
   *  different list on a different machine. A constant would be wrong for
   *  everyone but its author.
   *
   *  Moved here from an application HTTP route that spawned `opencode models`
   *  itself — provider anatomy leaking into application code. The two details
   *  that came with it are the ones that are easy to lose: the timeout, and the
   *  PATH augmentation for the two install dirs a spawned process often does
   *  not inherit.
   *
   *  Spawns once per call and caches nothing: freshness is the caller's policy,
   *  and a dropdown and a public `/v1/models` endpoint want very different
   *  answers to it. */
  async listModels(): Promise<string[]> {
    try {
      const { stdout } = await run(this.binary, ["models"], {
        timeout: 15_000,
        // Unlike `serverEnv()`, this inherits the ambient environment: it only
        // lists, it never runs a turn, so there is no answer for a stray
        // variable to change. PATH is still augmented with the two install
        // dirs a spawned process often does not inherit.
        env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/opt/homebrew/bin` },
      });
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("/"));
    } catch {
      // An empty list, never a throw: the binary being absent or
      // unauthenticated is a normal state for a machine that has not set
      // opencode up, and the caller's model field must stay usable as free
      // text either way. Failing here would put an error in front of someone
      // who was about to type a perfectly good model name.
      return [];
    }
  }
}
