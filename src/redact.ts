/** Redaction for anything this package hands back to a caller.
 *
 *  The channel that leaks is the **return** channel, not a log. No adapter here
 *  writes to stdout or stderr; what reaches somebody else's machine is
 *  `LLMStreamChunk.details`, a thrown `Error`'s message, and whatever a provider
 *  put in an event we pass along. Those strings get logged, pasted into issues
 *  and shipped to error trackers by the applications that receive them, which
 *  makes them exactly as public as a commit and rather more frequent — an error
 *  path runs on every failure, while a fixture is a copy nobody reads.
 *
 *  **Shape first, environment second.** An earlier version derived everything
 *  from `HOME` and `USER`, which was the right move away from a fixed list of
 *  prefixes and the wrong thing to rely on: with no `HOME` — a container, a
 *  daemon, a cron job — the main protection vanished *silently*; a short `HOME`
 *  substituted `~` in the middle of ordinary words; and a generic `USER` like
 *  `root` or `api` corrupted prose, turning `rootCause` into `[user]Cause`.
 *  Length cannot tell a username from a common word. So absolute path *forms*
 *  are recognised directly, which is anchored where a substring is not, covers
 *  somebody else's machine as well as this one, and survives an absent `HOME`.
 *  The environment stays as an additional signal, never as the mechanism.
 *
 *  **Redaction must not cost the debuggability it protects.** `details` exists so
 *  a caller can diagnose a spawn failure, and a string scrubbed into uselessness
 *  trades one defect for another. The error text, the exit code and the shape of
 *  what came back all survive; what goes is the identifying values.
 */

/** Keys whose values name a machine, a person, a session, or a filesystem
 *  location. Two of these are this package's own `LLMConfig` fields: an error
 *  echoing the config it was handed would otherwise return the binary path the
 *  user configured. */
const IDENTIFYING =
  /^(directory|dir|folder|path|paths|filePath|file|filename|location|source|bin|binary|executable|config_path|log_path|cwd|pwd|workdir|basePath|project_dir|root|worktree|memory_paths|messaging_socket_path|socket_path|session_id|sessionID|sessionId|uuid|user|username|home|hostname|claudeCodePath|opencodePath)$/i;

/** Absolute path shapes, matched by form rather than by comparison with this
 *  machine's environment. Anchored on the root segment, so unlike a substring
 *  replacement it cannot fire in the middle of a word. */
const ABSOLUTE_PATH =
  /(?:\/(?:Users|home)\/[^\s"'`,;:)\]}]*|\/root(?:\/[^\s"'`,;:)\]}]*)?|[A-Za-z]:\\[^\s"'`,;:)\]}]*|\\\\[^\s"'`,;:)\]}]*)/g;

/** Usernames too generic to substitute. `root` is the container default and
 *  `api`, `app`, `node` and friends appear inside ordinary paths and
 *  identifiers, so replacing them would corrupt the message this redaction is
 *  meant to keep readable. */
const GENERIC_USERS = new Set([
  "root", "admin", "administrator", "user", "users", "api", "app", "apps", "node",
  "runner", "ubuntu", "debian", "alpine", "docker", "build", "builder", "ci", "cd",
  "www-data", "nobody", "daemon", "test", "dev", "git", "home", "work", "src",
]);

/** Secret values this process has been handed and must never echo back.
 *
 *  The config helper lets a caller keep an API key in
 *  `~/.llm-adapters/config.json`, and a
 *  configured key that is not registered here reopens exactly the channel this
 *  file closed: a provider error carrying the request would put the key in front
 *  of whatever the caller does with an error. A new feature must not walk back a
 *  fix.
 *
 *  Module-level and additive on purpose. It holds values, never names, and
 *  nothing reads it back out — it exists only to be subtracted from outbound
 *  text. */
const SECRETS = new Set<string>();

/** Registers a value that must be scrubbed from anything this package returns.
 *
 *  Called wherever a key **enters the library** — `getLLMAdapter`, both API
 *  adapter constructors, and the config helper — rather than only in the helper.
 *  Registering in one opt-in place protected the path nobody uses yet and left
 *  every existing consumer exactly as it was.
 *
 *  **Two declared limits.** A value shorter than 8 characters is not registered
 *  at all: a short "secret" matches inside ordinary words and turns every error
 *  message into noise, which is the failure mode redaction has to avoid to stay
 *  worth having. And a value containing a character that JSON escapes will not
 *  match inside a `JSON.stringify` result, because the scrub is a literal
 *  split/join — a real provider key has neither property, and both are written
 *  down rather than left to look like coverage: a declared limit is acceptable,
 *  an undeclared one is the defect. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.length >= 8) SECRETS.add(value);
}

const MAX_DEPTH = 8;

/** Walks a parsed structure and replaces identifying values, keeping the shape.
 *
 *  The shape is the useful half: a caller debugging a failure needs to see that
 *  a `result` event arrived and what its `subtype` was, not where it ran.
 *
 *  **Past the depth limit the value is replaced, not returned.** The limit is a
 *  recursion guard, and a guard that hands back the untouched value at the
 *  boundary is an exit — everything below it escaped whole, which is worst
 *  exactly where nesting is deepest and least inspected. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return "[redacted-depth]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!IDENTIFYING.test(k)) {
      out[k] = redactValue(v, depth + 1);
      continue;
    }
    // Shape survives redaction, including for a list. `memory_paths` is an
    // array, and replacing it with a bare string broke the promise this
    // function's own comment makes.
    out[k] = Array.isArray(v) ? v.map(() => "[redacted]") : "[redacted]";
  }
  return out;
}

/** Replaces identifying text: path forms first, then this machine's own
 *  identifiers as an additional signal, then any registered secret. */
function scrub(line: string): string {
  let out = line.replace(ABSOLUTE_PATH, "[path]");

  const home = process.env.HOME;
  // Well above two characters: `/a` and `/ap` passed the old guard and rewrote
  // the middle of ordinary words. Anything shorter than this is a root-level
  // directory the form matcher above already handles.
  if (home && home.length >= 6) out = out.split(home).join("[path]");

  const user = process.env.USER;
  if (user && user.length >= 3 && !GENERIC_USERS.has(user.toLowerCase())) {
    // Word-anchored, not a substring. That is the same reason the path forms
    // above are anchored: a raw `split`/`join` on a short username rewrites the
    // middle of ordinary words, and a length threshold high enough to prevent
    // that is also high enough to stop scrubbing real three-letter usernames.
    // Anchoring gets both -- `(as ada)` is replaced, `adapter` is not.
    out = out.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "[user]");
  }

  // Registered secrets last: a key can appear anywhere, including inside a
  // string the replacements above just rewrote.
  for (const secret of SECRETS) out = out.split(secret).join("[redacted-secret]");
  return out;
}

/** Parses `text` as a JSON object or array and redacts it, or `null`. */
function asRedactedJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.stringify(redactValue(JSON.parse(trimmed)));
  } catch {
    return null;
  }
}

/** Redacts a block of provider output on its way to a caller.
 *
 *  The whole block is tried as JSON **first**, which is what catches
 *  pretty-printed output: a line-by-line reader can never parse multi-line JSON,
 *  so every line falls through to the text path and only the path *values* are
 *  caught. That is realistic rather than theoretical — `details` concatenates
 *  stderr, and stderr is exactly where a runtime dumps formatted JSON.
 *
 *  **Declared limit, stated precisely:** pretty-printed JSON *embedded inside
 *  other text* reaches only the text treatment, so its identifying **keys** are
 *  not honoured — the key stays visible and the value is not replaced by
 *  `[redacted]`. It does **not** leak: the path forms catch the value on the
 *  text path and it comes out as `[path]`. The limit is in the mechanism, not in
 *  the effect, and an earlier version of this comment overstated it in the
 *  pessimistic direction. Falling back to the text path stopped implying a leak
 *  the moment shape matching moved there, which is the whole reason shape is the
 *  primary mechanism rather than a supplement. */
export function redactText(text: string): string {
  const whole = asRedactedJson(text);
  if (whole !== null) return scrub(whole);

  return text
    .split("\n")
    .map((line) => {
      const json = asRedactedJson(line);
      return json !== null ? scrub(json) : scrub(line);
    })
    .join("\n");
}

/** A caught error as the text an error chunk carries: the message, redacted.
 *  Not `String(err)`, which prefixes `Error: ` -- the stream chunk and the
 *  thrown error then began differently for the same failure. */
export function errorText(err: unknown): string {
  return redactText(err instanceof Error ? err.message : String(err));
}
