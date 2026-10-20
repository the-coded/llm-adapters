import { execFileSync } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import path from "node:path";
import type { LLMAdapter, LLMMessage, LLMStreamChunk, LLMUsage, StreamOptions } from "../types.js";
import { errorText, redactText } from "../redact.js";
import { killProcessTree, spawnGroup } from "../process-group.js";

/** Absolute places the `claude` binary is worth looking for, before falling back
 *  to `which`.
 *
 *  The list exists for the case `which` cannot serve: a spawned process that did
 *  not inherit the developer's shell PATH, which is the normal situation for a
 *  GUI application on macOS and for anything launched by a supervisor.
 *
 *  **nvm is expanded, not guessed.** This list used to carry
 *  `~/.nvm/versions/node/current/bin/claude`, and nvm creates no `current`
 *  symlink in a default install -- it switches versions by rewriting PATH, and
 *  the directory is the version (`v24.14.1`). So the one candidate that existed
 *  to cover the most common developer install was the one that could never match
 *  it, and when `which` also failed the error named four paths, none of them
 *  where an nvm user's binary actually is. The comment on `resolvedBin` below had
 *  already recorded "no nvm `current` alias installed" as an aside in an argument
 *  about subprocess pressure: the fact was observed and the code was not changed.
 *
 *  Newest version first, because a machine with several installed is far more
 *  likely to want the newest, and an executable check follows anyway. */
export function claudeCandidates(customPath?: string): string[] {
  const home = process.env.HOME ?? "";
  const nvmRoot = `${home}/.nvm/versions/node`;
  let nvmVersions: string[] = [];
  try {
    nvmVersions = readdirSync(nvmRoot)
      .filter((entry) => entry.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => `${nvmRoot}/${version}/bin/claude`);
  } catch {
    // No nvm on this machine, which is not an error and not worth reporting.
  }

  return [
    ...(customPath && path.isAbsolute(customPath) ? [customPath] : []),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${home}/.npm-global/bin/claude`,
    ...nvmVersions,
  ];
}

/**
 * ClaudeCodeAdapter — calls the `claude` CLI as a subprocess.
 *
 * Streaming: `claude --print --output-format stream-json --verbose --include-partial-messages`
 * Non-streaming: `claude --print --output-format json`
 *
 * Install: npm install -g @anthropic-ai/claude-code
 * Auth: claude login
 *
 * No `listModels()`: the `claude` CLI has no listing command, so this adapter
 * cannot ask its provider at all and omits the optional method rather than
 * implementing it as a static echo of the catalog. A caller feature-detects
 * and falls back to `PROVIDERS["claude-code"].models`.
 *
 * Trust boundary: this spawns a local subprocess carrying the calling
 * process's own PATH. That is acceptable for a local developer tool — never
 * expose it through a public-facing deployment without real sandboxing.
 */
export class ClaudeCodeAdapter implements LLMAdapter {
  readonly supportsFileTools = true;

  private model: string;
  /** Caller-supplied override path (`LLMConfig.claudeCodePath`) — tried
   * before the fixed candidate list, for installs `findClaudeBin()` doesn't
   * know about (a version manager, a custom prefix, etc.). */
  private customPath?: string;
  /** Resolved once per adapter instance, not once per call. Before this, a
   *  batch run resolved it fresh for every item -- and where none of the
   *  absolute candidates match
   *  (no nvm `current` alias installed), so every call fell through to an
   *  extra `execFileSync("which", ...)` subprocess on top of the `claude`
   *  spawn itself, doubling subprocess pressure on exactly the resource a
   *  batch run exhausts first (measured 2026-06-07). Callers that build one
   *  adapter and keep it for a whole loop pay the resolution once. */
  private resolvedBin: string | null = null;

  constructor(model: string, customPath?: string) {
    this.model = model;
    this.customPath = customPath;
  }

  private buildPrompt(systemPrompt: string, messages: LLMMessage[]): string {
    const parts: string[] = [];
    if (systemPrompt) {
      parts.push(`<system>\n${systemPrompt}\n</system>`);
    }
    for (const msg of messages) {
      const role = msg.role === "user" ? "Human" : "Assistant";
      parts.push(`${role}: ${msg.content}`);
    }
    return parts.join("\n\n");
  }

  private findClaudeBin(): string {
    if (this.resolvedBin) return this.resolvedBin;

    // No shell: `customPath` is caller-supplied, often straight from a
    // request body, so the old `execSync(\`test -f "${bin}"\`)` was a command-injection
    // hole (`"; rm -rf ~; #`). Probe the filesystem directly instead, and
    // only accept an absolute customPath so it can't smuggle shell/PATH
    // tricks. A bare "claude" name is resolved via `which` with execFileSync
    // (argv array — no shell interpolation).
    // An explicit path is an instruction, not a hint. If it is set and does not
    // work, this fails naming it rather than quietly resolving something else:
    // silently running a different binary is the same class of defect as a
    // vendor key reaching another vendor, or a masked value overwriting a real
    // one -- explicit configuration that does not apply, without saying so.
    //
    // Found by somebody passing a path that did not exist and being billed for
    // two runs of the CLI it fell back to.
    // `!== undefined`, not truthiness: an empty string is an explicit (and wrong)
    // setting, and falsy would skip straight to the fallback it exists to refuse.
    if (this.customPath !== undefined) {
      if (!path.isAbsolute(this.customPath)) {
        // Redacted like every other message here, the caller's own value
        // included: an error is what gets logged, and the path is a home path.
        throw new Error(
          redactText(
            `claudeCodePath must be an absolute path, got "${this.customPath}". A relative path would resolve against the spawned process's working directory, not yours.`,
          ),
        );
      }
      try {
        accessSync(this.customPath, constants.X_OK);
      } catch {
        throw new Error(
          redactText(
            `claudeCodePath points at "${this.customPath}", which is not an executable file. Fix the path, or remove claudeCodePath to fall back to the usual locations and \`which claude\`.`,
          ),
        );
      }
      this.resolvedBin = this.customPath;
      return this.customPath;
    }

    const absoluteCandidates = claudeCandidates(this.customPath);
    for (const bin of absoluteCandidates) {
      try {
        accessSync(bin, constants.X_OK);
        this.resolvedBin = bin;
        return bin;
      } catch {
        /* try next */
      }
    }
    try {
      const which = execFileSync("which", ["claude"], { encoding: "utf-8" }).trim();
      if (which) {
        this.resolvedBin = which;
        return which;
      }
    } catch {
      /* fall through to the clear error below */
    }
    // Distinguishes THIS -- the binary genuinely isn't findable -- from a
    // transient spawn failure once `spawn()` is actually attempted. The two
    // were conflated under one "Failed to spawn claude CLI" message before
    // (measured 2026-06-07), and that cost a wrong diagnosis: a
    // resource-exhaustion event read as a PATH problem.
    throw new Error(
      redactText(
        `claude CLI not found: it is not on this process's PATH, and it is not at any of ${absoluteCandidates.join(", ")}. ` +
          "If `which claude` finds it in your shell but this did not, the spawned process is not inheriting your PATH -- pass the path as `claudeCodePath`. " +
          "If it finds nothing, install it with `npm install -g @anthropic-ai/claude-code`.",
      ),
    );
  }

  private spawnEnv(): NodeJS.ProcessEnv {
    // Minimal env — do NOT spread process.env, which may carry the server's
    // own API keys into a CLI running LLM-authored file operations. The CLI
    // needs PATH (to find node/its own deps), plus HOME and USER to reach
    // its `claude login` credentials. NODE_ENV is passed through because the
    // CLI and its own dependencies may branch on it, and leaving it unset is
    // a different environment from `"development"`.
    //
    // USER is not optional and not cosmetic: on macOS the credentials live
    // in the login Keychain (item `Claude Code-credentials`), and without
    // USER the CLI reports `"loggedIn": false, "authMethod": "none"` and
    // every turn dies with "Not logged in · Please run /login" — verifiable
    // with `env -i PATH=… HOME=… NODE_ENV=… claude auth status`, adding and
    // removing USER alone. Don't drop it while tidying this allowlist.
    return {
      PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/opt/homebrew/bin`,
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
      NODE_ENV: process.env.NODE_ENV ?? "development",
    } as NodeJS.ProcessEnv;
  }

/** An already-aborted signal has to stop the call **before** the spawn.
 *
 *  `addEventListener("abort", …)` never fires for an abort that already
 *  happened, so a call made with a spent signal used to spawn a process nothing
 *  would ever kill. Found measuring Ctrl-C: the first call's child died and the
 *  second — started after the signal was already aborted — was orphaned. Half a
 *  fix looked like a flaky one.
 *
 *  Checking `aborted` up front is also simply correct: an aborted call should
 *  not start. */
  async *stream(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: StreamOptions
  ): AsyncGenerator<LLMStreamChunk> {
    const prompt = this.buildPrompt(systemPrompt, messages);

    if (options?.signal?.aborted) {
      yield { type: "error", error: "aborted before the CLI was started" };
      return;
    }

    try {
      const claudeBin = this.findClaudeBin();

      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        this.model,
      ];

      // Pin the permission mode instead of inheriting the user's own default
      // from ~/.claude/settings.json. A personal `"defaultMode": "plan"`
      // there made turns answer "I can't exit plan mode" instead of doing
      // the work. Not inheriting that is the whole point of this line — the
      // specific mode matters less now that callers decide what (if
      // anything) the CLI may touch through `allowedTools`.
      args.push("--permission-mode", "acceptEdits");

      if (options?.allowedTools && options.allowedTools.length > 0) {
        args.push("--allowedTools", options.allowedTools.join(","));
      }
      if (options?.textOnly) {
        // Three flags because three separate mechanisms feed the session.
        // `--tools ""` empties the built-in set; --strict-mcp-config drops
        // the MCP servers inherited from the developer's config (verified to
        // be the difference between `tools: []` and a session still holding a
        // plugin's code-execution tools); --safe-mode disables hooks, skills
        // and CLAUDE.md discovery — measured with --include-hook-events as
        // 12 hook events and an injected plugin persona before, 0 after.
        //
        // Not `--bare`, which covers the same ground but documents that
        // "OAuth and keychain are never read" — it would break subscription
        // login, which is the whole reason this provider exists.
        args.push("--tools", "");
        args.push("--strict-mcp-config");
        args.push("--safe-mode");
      }
      if (options?.maxTurns !== undefined) {
        args.push("--max-turns", String(options.maxTurns));
      }

      const proc = spawnGroup(claudeBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.spawnEnv(),
        cwd: options?.cwd,
        // A group leader, so aborting reaches the CLI's own children. Without
        // it a grandchild keeps the inherited stdout open and this never ends.
      });

      // A failed spawn (binary missing, EACCES) makes the stdin write throw
      // EPIPE asynchronously — unhandled, that takes down the whole host
      // process. Swallow it here; `proc.on("error")` below turns it into a
      // proper error chunk.
      proc.stdin.on("error", () => {});

      // Client disconnected (navigated away mid-stream): kill the CLI so it
      // doesn't keep running with file-write access after nobody's reading.
      const onAbort = () => killProcessTree(proc);
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      proc.stdin.write(prompt, "utf-8");
      proc.stdin.end();

      type QueueItem = LLMStreamChunk | null;
      const queue: QueueItem[] = [];
      let resolveNext: (() => void) | null = null;
      let finalError: string | null = null;
      let closed = false;

      function enqueue(item: QueueItem) {
        queue.push(item);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      }

      let buffer = "";
      let receivedDeltas = false;
      // At most ONE `onUsage` per call. The contract is one report per provider
      // invocation, not one per event -- `complete()` has always behaved that
      // way, and a `stream()` that fired per `result` line would silently double
      // somebody's spend total if the CLI ever emitted two.
      let usageReported = false;
      let stderrBuffer = "";
      const recentLines: string[] = [];
      const MAX_DEBUG_LINES = 30;

      function processJsonLine(trimmed: string) {
        recentLines.push(trimmed);
        if (recentLines.length > MAX_DEBUG_LINES) recentLines.shift();

        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;

          if (
            parsed.type === "stream_event" &&
            typeof parsed.event === "object" &&
            parsed.event !== null
          ) {
            const evt = parsed.event as Record<string, unknown>;
            if (
              evt.type === "content_block_delta" &&
              typeof evt.delta === "object" &&
              evt.delta !== null &&
              (evt.delta as Record<string, unknown>).type === "text_delta"
            ) {
              receivedDeltas = true;
              enqueue({
                type: "text",
                text: String((evt.delta as Record<string, unknown>).text ?? ""),
              });
            }
            return;
          }

          // The `result` event carries `modelUsage` and `total_cost_usd`, and it
          // has always flowed through this same loop and been dropped on the
          // floor. That is why the usage channel worked on `complete()` and not
          // here: the feature was built against the only path its first
          // consumer used. A consumer whose only call site is `stream()` got
          // nothing at all.
          if (parsed.type === "result") {
            if (!usageReported) {
              const usage = extractUsage(parsed);
              if (usage) {
                usageReported = true;
                options?.onUsage?.(usage);
              }
            }
            return;
          }

          if (parsed.type === "assistant") {
            const msg = parsed.message as Record<string, unknown> | undefined;
            const content = msg?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as Record<string, unknown>;
                if (b.type === "text" && typeof b.text === "string" && !receivedDeltas) {
                  enqueue({ type: "text", text: b.text });
                } else if (b.type === "tool_use") {
                  // A file write can take minutes; without this the panel
                  // shows a bare "…" the whole time with no signal that
                  // anything is happening.
                  const input = b.input as Record<string, unknown> | undefined;
                  const target = typeof input?.file_path === "string" ? input.file_path : undefined;
                  enqueue({
                    type: "tool_use",
                    text: String(b.name ?? "tool"),
                    details: target,
                  });
                }
              }
            }
          }
        } catch {
          // Not valid JSON — ignore (e.g. progress indicators, debug output)
        }
      }

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) processJsonLine(trimmed);
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        // Accumulate for the error `details` payload, but do NOT treat a
        // stderr line as failure just because it contains "error"/"failed":
        // the CLI writes benign warnings (and the model's own text) there,
        // which turned successful runs into error chunks. The exit code in
        // the `close` handler is the authoritative success/failure signal.
        stderrBuffer += data.toString();
      });

      proc.on("error", (err) => {
        finalError = redactText(`Failed to spawn claude CLI: ${err.message}`);
        closed = true;
        enqueue(null);
      });

      proc.on("close", (code, signal) => {
        if (buffer.trim()) {
          processJsonLine(buffer.trim());
          buffer = "";
        }
        if (code !== 0 && !finalError) {
          // A signal death has no code (it is null), so the signal is named.
          finalError = signal ? `claude CLI exited by signal ${signal}` : `claude CLI exited with code ${code}`;
        }
        closed = true;
        enqueue(null);
      });

      while (true) {
        if (queue.length === 0) {
          if (closed) break;
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }

        const item = queue.shift();
        if (item === null) break;
        if (item === undefined) continue;
        yield item;
      }

      options?.signal?.removeEventListener("abort", onAbort);

      if (finalError) {
        const parts: string[] = [];
        if (stderrBuffer.trim()) parts.push(stderrBuffer.trim());
        if (recentLines.length > 0) parts.push("--- stdout (last lines) ---\n" + recentLines.join("\n"));
        // Redacted on the way out. `recentLines` is the CLI's raw JSON events,
        // and the `result` event is the last line of every run, so it is always
        // inside this window -- it carries `cwd`, `memory_paths`,
        // `messaging_socket_path`, `session_id`, `uuid` and the home directory.
        // This is the channel that runs on every failure, and it reaches
        // whatever the caller does with an error: a log, an issue, a tracker.
        const joined = parts.join("\n\n");
        const details = joined ? redactText(joined) : undefined;
        yield { type: "error", error: finalError, details };
      } else {
        yield { type: "done" };
      }
    } catch (err) {
      yield { type: "error", error: errorText(err) };
    }
  }

  async complete(
    systemPrompt: string,
    messages: LLMMessage[],
    options?: { model?: string; signal?: AbortSignal; onUsage?: (usage: LLMUsage) => void }
  ): Promise<string> {
    const prompt = this.buildPrompt(systemPrompt, messages);

    if (options?.signal?.aborted) {
      return Promise.reject(new Error("aborted before the CLI was started"));
    }

    return new Promise((resolve, reject) => {
      const claudeBin = this.findClaudeBin();
      const args = ["--print", "--output-format", "json", "--model", options?.model ?? this.model];

      const proc = spawnGroup(claudeBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.spawnEnv(),
      });

      // Client disconnected, or the caller's own timeout fired: kill the CLI
      // instead of leaving it running forever with nobody left to read the
      // result -- the same wiring `stream()` already had above; this method
      // never did until `signal` was added to its options.
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        killProcessTree(proc);
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      // Without these, a failed spawn either crashes the process (unhandled
      // EPIPE on stdin) or leaves this promise pending forever (no `close`
      // event fires when spawn itself fails).
      proc.stdin.on("error", () => {});
      proc.on("error", (err) => {
        options?.signal?.removeEventListener("abort", onAbort);
        reject(new Error(redactText(`Failed to spawn claude CLI: ${err.message}`)));
      });

      proc.stdin.write(prompt, "utf-8");
      proc.stdin.end();

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code, signal) => {
        options?.signal?.removeEventListener("abort", onAbort);
        if (aborted) {
          reject(new Error("claude CLI aborted (client disconnect or timeout)"));
          return;
        }
        if (code !== 0) {
          const how = signal ? `signal ${signal}` : `code ${code}`;
          reject(new Error(redactText(`claude CLI failed (${how}): ${stderr.trim()}`)));
          return;
        }
        resolve(readCliOutput(stdout, options?.onUsage));
      });
    });
  }
}

/** Pulls the consumption out of the `result` event of
 *  `claude --print --output-format json`.
 *
 *  Exported so a test can measure it against a real sample saved on disk
 *  (`test/fixtures/claude-code-result.json`) rather than a mock, which is the
 *  rule this package keeps for anything that parses somebody else's output.
 *
 *  **The numbers come from `modelUsage`, not from `usage`, and that was
 *  measured rather than chosen by taste.** In the real 2026-06-13 sample the
 *  two disagree: `usage.input_tokens` says **10** while
 *  `modelUsage[...].inputTokens` says **908**; output, 113 against 122.
 *  `usage` describes the last iteration of the call (the object itself carries
 *  an `iterations` array), while `modelUsage` aggregates the whole call.
 *  Reading `usage` would under-report input by 90x -- and silent
 *  under-reporting in a spend figure is worse than absence, because it looks
 *  complete.
 *
 *  Sums across models because the CLI may use more than one in a single call
 *  (a subagent, a fast model): the total is what was spent, and `models`
 *  preserves which ones they were, or "I spent on two models" would become
 *  "I spent on one".
 *
 *  Returns `null` when there is nothing to report -- and then the callback is
 *  never invoked, because silence means "unknown" and never zero. */
export function extractUsage(obj: Record<string, unknown> | undefined): LLMUsage | null {
  const perModel = obj?.modelUsage as Record<string, Record<string, unknown>> | undefined;
  const entries = perModel && typeof perModel === "object" ? Object.entries(perModel) : [];

  /** A reported number, or `null`. Negative dollars are rejected here rather
   *  than passed on: a negative cost is not a refund this package can read, it
   *  is a malformed number entering a spend total. */
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const money = (v: unknown): number | null => {
    const n = num(v);
    return n !== null && n >= 0 ? n : null;
  };

  /** Sums the entries that reported this field, and stays `null` when none did.
   *  A field nobody reported is unknown, and `0` would claim it was measured. */
  const sum = (key: string): number | null => {
    let total: number | null = null;
    for (const [, m] of entries) {
      const v = num(m[key]);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };

  if (entries.length === 0) {
    // No per-model breakdown. If the provider nonetheless stated a total, that
    // dollar figure is a fact it reported, and discarding it for want of a
    // token breakdown loses the number a spending decision turns on. Every
    // token field stays `null` because they are genuinely unknown -- reporting
    // them as 0 would make an unmeasured call look like a free one.
    const only = money(obj?.total_cost_usd);
    if (only !== null) {
      return { model: null, models: [], inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUSD: only, costBasis: null };
    }
    return null;
  }

  // Dollars come from `total_cost_usd` when present, otherwise from the sum of
  // the per-model `costUSD`. `null` -- not 0 -- when neither reports: a silent
  // provider must not become "it cost zero" inside a run's total.
  let costUSD = money(obj?.total_cost_usd);
  if (costUSD === null) {
    const known = entries.map(([, m]) => money(m.costUSD)).filter((c): c is number => c !== null);
    costUSD = known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
  }

  // The call's "model" is the one that took the MONEY, not the one that took
  // the tokens -- and the difference is not theoretical, it was measured on
  // 2026-06-13. One call asking for `claude-opus-5` reported TWO models: haiku
  // with 898 input tokens and $0.000943, and opus with 2 tokens and **$0.336**.
  // Choosing by token count would label it "haiku" for 99.7% of money that went
  // to opus, and a spend display would attribute the cost to the wrong model.
  //
  // With no cost reported anywhere, it falls back to tokens, which is the only
  // ordering available -- and there `costUSD` is `null` anyway, so there is no
  // money to misattribute.
  const tokensOf = (m: Record<string, unknown>) => (num(m.inputTokens) ?? 0) + (num(m.outputTokens) ?? 0);
  const anyCost = entries.some(([, m]) => money(m.costUSD) !== null);
  const dominant = entries.reduce((largest, current) =>
    anyCost
      ? (money(current[1].costUSD) ?? -1) > (money(largest[1].costUSD) ?? -1)
        ? current
        : largest
      : tokensOf(current[1]) > tokensOf(largest[1])
        ? current
        : largest,
  );
  // The price basis comes from the dominant model; if the models of one call
  // disagree about it, keeping just one would be us choosing, so the
  // disagreement becomes `null` -- absence, never one of the two.
  const bases = new Set(entries.map(([, m]) => (typeof m.costBasis === "string" ? m.costBasis : null)).filter((b): b is string => b !== null));
  const costBasis = bases.size === 1 ? [...bases][0]! : null;
  return {
    model: dominant[0],
    models: entries.map(([k]) => k),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadInputTokens"),
    cacheCreationTokens: sum("cacheCreationInputTokens"),
    costUSD,
    costBasis,
  };
}

/** Text AND consumption from one `claude --print --output-format json` output,
 *  with the callback fired in here.
 *
 *  A function of its own, rather than a passage inside the `close` handler,
 *  for a reason fault injection proved: **with the callback fired inside the
 *  handler, no test could reach it without spawning a subprocess.** Deleting
 *  the call left the whole suite green, because test doubles invoke `onUsage`
 *  themselves and the extractor's test measures the extractor in isolation --
 *  both halves covered, the thread between them not. The fix is to move the
 *  seam to where it can be measured, not to add a test around it.
 *
 *  Shape compatibility, checked directly against the installed CLI (2.1.261):
 *  `--output-format json` returns an ARRAY of events
 *  (system/assistant/rate_limit/result), not a flat object. The old flat-object
 *  assumption returned the entire raw stdout as "the answer" instead of
 *  throwing, because `parsed.result` on an array is `undefined` and fell
 *  through to the fallback. Both shapes stay accepted, so this also works
 *  against the CLI version the original code was written for. */
export function readCliOutput(stdout: string, onUsage?: (usage: LLMUsage) => void): string {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    const resultEvent = Array.isArray(parsed) ? parsed.find((e) => (e as Record<string, unknown>)?.type === "result") : parsed;
    const obj = resultEvent as Record<string, unknown> | undefined;
    const text = obj?.result ?? obj?.content ?? stdout.trim();
    // The consumption was always here, in the SAME object, and was thrown away
    // on every call until `onUsage` gave it somewhere to go.
    const usage = extractUsage(obj);
    if (usage) onUsage?.(usage);
    return String(text);
  } catch {
    return stdout.trim();
  }
}
