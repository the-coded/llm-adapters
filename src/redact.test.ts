import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactValue } from "./redact.js";

test("identifying fields go, the shape stays", () => {
  const event = {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "d3f1-real",
    uuid: "aaaa-bbbb",
    cwd: "/Users/someone/projects/thing",
    memory_paths: ["/Users/someone/.claude/CLAUDE.md"],
    messaging_socket_path: "/tmp/cc-socks/71609.sock",
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  const out = redactValue(event) as Record<string, unknown>;

  // The half a caller debugging a failure actually needs.
  assert.equal(out.type, "result");
  assert.equal(out.subtype, "success");
  assert.equal(out.is_error, false);
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 2 });

  for (const key of ["session_id", "uuid", "cwd", "messaging_socket_path"]) {
    assert.equal(out[key], "[redacted]", `${key} survived redaction`);
  }
  // Shape survives redaction for a list too. `memory_paths` is an array, and
  // replacing it with a bare string broke the promise the redactor makes about
  // keeping shape -- a contract slip rather than a leak, but one either way.
  assert.deepEqual(out.memory_paths, ["[redacted]"]);
});

/** The depth limit is a recursion guard, and a guard that returns the untouched
 *  value at the boundary is an exit: everything below it escapes whole, which is
 *  worst exactly where nesting is deepest and least inspected. Measured at the
 *  boundary rather than asserted in the middle. */
test("past the depth limit the value is replaced, not returned", () => {
  const nest = (depth: number): unknown => {
    let node: unknown = { cwd: "/Users/someone/secret" };
    for (let i = 0; i < depth; i++) node = { level: node };
    return node;
  };
  for (const depth of [7, 8, 9, 10, 20]) {
    const out = JSON.stringify(redactValue(nest(depth)));
    assert.ok(!out.includes("/Users/someone/secret"), `a path at depth ${depth} escaped whole`);
  }
});

/** Pretty-printed JSON is the realistic case, not a contrived one: `details`
 *  concatenates stderr, and stderr is where a runtime dumps formatted JSON. A
 *  line-by-line reader can never parse it, so every line used to fall through to
 *  the text path -- and a path belonging to **another** machine survived there,
 *  key and value both. */
test("pretty-printed JSON is redacted, and a foreign path is caught by form", () => {
  const pretty = JSON.stringify({ cwd: "/home/someone-else/project", note: "kept" }, null, 2);
  const out = redactText(pretty);
  assert.ok(!out.includes("/home/someone-else/project"), "a foreign path survived pretty-printed JSON");
  assert.ok(out.includes("kept"), "the non-identifying field was lost");

  // Embedded in other text it reaches only the text path, which is a declared
  // limit -- and the path form still catches the leak that matters.
  const embedded = `error while running:\n${pretty}\ndone`;
  assert.ok(!redactText(embedded).includes("/home/someone-else/project"));
});

// Shape matching has to work with no environment at all -- a container, a
// daemon, a cron job -- which is where deriving everything from HOME failed
// silently.
test("paths are caught with no HOME and no USER set", () => {
  const home = process.env.HOME;
  const user = process.env.USER;
  delete process.env.HOME;
  delete process.env.USER;
  try {
    for (const path of ["/Users/ada/work/secret", "/home/ada/work/secret", "/root/.config/thing", "C:\\Users\\ada\\secret"]) {
      assert.ok(!redactText(`failed at ${path}`).includes(path), `${path} survived with no environment`);
    }
  } finally {
    if (home !== undefined) process.env.HOME = home;
    if (user !== undefined) process.env.USER = user;
  }
});

// And it must not corrupt prose. A generic username is not substituted at all,
// and a real one is word-anchored rather than replaced as a substring.
test("redaction does not corrupt ordinary text", () => {
  const user = process.env.USER;
  try {
    process.env.USER = "root";
    assert.equal(redactText("rootCause: the root cause"), "rootCause: the root cause");
    process.env.USER = "ada";
    assert.equal(redactText("the adapter is fine"), "the adapter is fine");
    assert.equal(redactText("signed by ada"), "signed by [user]");
  } finally {
    if (user !== undefined) process.env.USER = user;
    else delete process.env.USER;
  }
});

test("the running machine's own home and user are scrubbed out of plain text", () => {
  const home = process.env.HOME ?? "";
  const user = process.env.USER ?? "";
  const line = `Error: ENOENT, open '${home}/.config/thing' (as ${user})`;

  const out = redactText(line);

  assert.ok(out.includes("ENOENT"), "the error text did not survive");
  if (home.length > 1) assert.ok(!out.includes(home), "the home directory survived");
});

// A JSON line is parsed, walked and re-serialised; a non-JSON line is scrubbed
// as text. Mixed output is what a failing CLI actually produces.
test("redactText handles a mix of JSON events and plain stderr", () => {
  const home = process.env.HOME ?? "/home/nobody";
  const text = [
    `{"type":"result","cwd":"${home}/repo","subtype":"success"}`,
    `warning: something went wrong in ${home}/repo`,
    "not json at all {",
  ].join("\n");

  const out = redactText(text);

  assert.ok(out.includes('"subtype":"success"'), "event shape was lost");
  assert.ok(out.includes("[redacted]"), "the cwd field was not redacted");
  assert.ok(out.includes("warning: something went wrong"), "stderr text was lost");
  assert.ok(out.includes("not json at all {"), "an unparseable line was dropped");
  assert.ok(!out.includes(home), "the home directory survived somewhere");
});
