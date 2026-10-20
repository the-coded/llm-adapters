import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { shutdown, spawnGroup } from "./process-group.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import type { LLMStreamChunk } from "./types.js";

// POSIX `#!/bin/sh` fakes, the same convention as opencode.test.ts. Each fake
// records its own pid and its grandchild's, so the assertions look at real
// processes.
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}
const tmp = () => mkdtempSync(join(tmpdir(), "llm-adapters-pg-"));
const pids = (file: string) => readFileSync(file, "utf8").trim().split(/\s+/).map(Number);
const exited = (p: ReturnType<typeof spawnGroup>) =>
  new Promise<NodeJS.Signals | null>((r) => (p.exitCode !== null || p.signalCode ? r(p.signalCode) : p.once("exit", (_c, s) => r(s))));

test("shutdown stops an opencode serve that never became healthy, grandchild included", async () => {
  const dir = tmp();
  const pidFile = join(dir, "pids");
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh\nsleep 300 &\necho "$$ $!" > "${pidFile}.tmp"\nmv "${pidFile}.tmp" "${pidFile}"\nwait\n`);
  chmodSync(bin, 0o755);

  const chunks: LLMStreamChunk[] = [];
  const streaming = (async () => {
    for await (const c of new OpenCodeAdapter("anthropic/m", bin).stream("", [{ role: "user", content: "hi" }])) chunks.push(c);
  })();
  await waitFor(() => existsSync(pidFile));
  const [leader, grandchild] = pids(pidFile) as [number, number];

  const t0 = Date.now();
  await shutdown();
  assert.ok(Date.now() - t0 < 10_000, "resolved long before the 30 s boot timeout");
  await waitFor(() => !isAlive(leader) && !isAlive(grandchild), 3000);
  // The in-flight stream ends with its error chunk promptly, not at the boot
  // timeout: a server killed by a signal has no exit code to poll for.
  const t1 = Date.now();
  await streaming;
  assert.ok(Date.now() - t1 < 5_000, `the stream took ${Date.now() - t1} ms to end after shutdown`);
  assert.ok(chunks.some((c) => c.type === "error"));
});

test("shutdown sends SIGTERM to the whole group", async () => {
  const dir = tmp();
  const pidFile = join(dir, "pids");
  const proc = spawnGroup("sh", ["-c", `sleep 300 & echo "$$ $!" > "${pidFile}"; wait`], { stdio: "ignore" });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").includes(" "));
  const [leader, grandchild] = pids(pidFile) as [number, number];
  await shutdown();
  assert.equal(await exited(proc), "SIGTERM");
  await waitFor(() => !isAlive(leader) && !isAlive(grandchild), 3000);
});

test("shutdown escalates to SIGKILL for a child that ignores SIGTERM", async () => {
  const dir = tmp();
  const ready = join(dir, "ready");
  const proc = spawnGroup("sh", ["-c", `trap "" TERM; echo 1 > "${ready}"; while :; do sleep 1; done`], { stdio: "ignore" });
  await waitFor(() => existsSync(ready));
  const t0 = Date.now();
  await shutdown({ graceMs: 200 });
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.equal(await exited(proc), "SIGKILL");
});

test("shutdown is idempotent: concurrent calls share one run, a later call is immediate", async () => {
  const proc = spawnGroup("sh", ["-c", "sleep 300"], { stdio: "ignore" });
  let exits = 0;
  proc.on("exit", () => exits++);
  const a = shutdown();
  const b = shutdown();
  assert.equal(a, b);
  await Promise.all([a, b]);
  assert.equal(exits, 1);
  const t0 = Date.now();
  await shutdown();
  assert.ok(Date.now() - t0 < 100);
});

test("shutdown never rejects: exited process, empty registry, killed from outside", async () => {
  const done = spawnGroup("sh", ["-c", "exit 0"], { stdio: "ignore" });
  await exited(done);
  await shutdown();
  await shutdown();
  const victim = spawnGroup("sh", ["-c", "sleep 300"], { stdio: "ignore" });
  process.kill(-victim.pid!, "SIGKILL");
  await shutdown();
  await shutdown();
});

test("a finished claude-code call leaves nothing registered", async () => {
  const dir = tmp();
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho '{"type":"result","result":"ok"}'\n`);
  chmodSync(bin, 0o755);
  for await (const _ of new ClaudeCodeAdapter("m", bin).stream("", [{ role: "user", content: "hi" }])) void _;

  const realKill = process.kill;
  const sent: unknown[] = [];
  process.kill = ((pid: number, sig?: string | number) => {
    if (sig !== 0) sent.push([pid, sig]);
    return realKill.call(process, pid, sig as never);
  }) as typeof process.kill;
  try {
    await shutdown();
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(sent, []);
});

test("SIGKILL reaches a member that ignores TERM after its leader died on TERM", async () => {
  const dir = tmp();
  const pidFile = join(dir, "pids");
  // The leader dies on TERM; the subshell ignores TERM and execs into sleep,
  // keeping the disposition, so only the group SIGKILL can reach it.
  const proc = spawnGroup("sh", ["-c", `(trap "" TERM; exec sleep 300) & echo "$$ $!" > "${pidFile}"; sleep 300`], { stdio: "ignore" });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").includes(" "));
  const [, member] = pids(pidFile) as [number, number];
  await shutdown({ graceMs: 200 });
  assert.equal(await exited(proc), "SIGTERM", "the leader should have died on TERM");
  await waitFor(() => !isAlive(member), 2000);
});

test("a spawn that fails leaves nothing registered", async () => {
  const proc = spawnGroup(join(tmp(), "no-such-binary"), [], { stdio: "ignore" });
  proc.on("error", () => {});
  await new Promise((r) => proc.once("close", r));
  // A leaked entry makes shutdown wait the whole grace period for an `exit`
  // that never comes. Observable on Bun, where a failed spawn keeps
  // `exitCode` null; Node sets it to -2, so there the leak is silent.
  const t0 = Date.now();
  await shutdown({ graceMs: 2000 });
  assert.ok(Date.now() - t0 < 500, `shutdown waited ${Date.now() - t0} ms on a process that never started`);
});

test("a graceMs that is not a finite number >= 0 means the default, not an immediate kill", async () => {
  const dir = tmp();
  const ready = join(dir, "ready");
  const proc = spawnGroup("sh", ["-c", `trap "" TERM; echo 1 > "${ready}"; while :; do sleep 1; done`], { stdio: "ignore" });
  await waitFor(() => existsSync(ready));
  const t0 = Date.now();
  await shutdown({ graceMs: -1 });
  assert.ok(Date.now() - t0 >= 2500, `escalated after ${Date.now() - t0} ms instead of the 3000 ms default`);
  assert.equal(await exited(proc), "SIGKILL");
});

test("a claude-code call stopped by shutdown names the signal, on both channels", async () => {
  const dir = tmp();
  const bin = join(dir, "claude");
  const ready = join(dir, "ready");
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho 1 > "${ready}"\nexec sleep 300\n`);
  chmodSync(bin, 0o755);
  const messages = [{ role: "user" as const, content: "hi" }];

  const chunks: LLMStreamChunk[] = [];
  const streaming = (async () => {
    for await (const c of new ClaudeCodeAdapter("m", bin).stream("", messages)) chunks.push(c);
  })();
  await waitFor(() => existsSync(ready));
  await shutdown();
  await streaming;
  assert.match(chunks.at(-1)?.error ?? "", /^claude CLI exited by signal SIGTERM/);

  rmSync(ready);
  const completing = new ClaudeCodeAdapter("m", bin).complete("", messages).then(
    () => assert.fail("complete() must reject"),
    (err: Error) => err.message,
  );
  await waitFor(() => existsSync(ready));
  await shutdown();
  assert.match(await completing, /^claude CLI failed \(signal SIGTERM\)/);
});

/** A host whose only remaining handle is the package's own: it has closed its
 *  server, and the process it owns is unref'd (as opencode's server is). The
 *  code after `await shutdown()` must still run, with the host's own exit code,
 *  and a child ignoring SIGTERM must still get the SIGKILL -- an unref'd grace
 *  timer let the host exit before `shutdown()` settled. */
for (const [label, script, signal] of [
  ["obeys SIGTERM", `echo 1 > "$READY"; exec sleep 300`, "SIGTERM"],
  ["ignores SIGTERM", `trap "" TERM; echo 1 > "$READY"; exec sleep 300`, "SIGKILL"],
] as const) {
  test(`a host with no other handles runs the code after await shutdown() (child ${label})`, () => {
    const dir = tmp();
    const ready = join(dir, "ready");
    const host = join(dir, "host.mjs");
    writeFileSync(
      host,
      `import { existsSync } from "node:fs";
import { shutdown, spawnGroup } from ${JSON.stringify(new URL("./process-group.js", import.meta.url).href)};
const child = spawnGroup("sh", ["-c", ${JSON.stringify(script)}], { stdio: "ignore", env: { ...process.env, READY: ${JSON.stringify(ready)} } });
child.unref();
while (!existsSync(${JSON.stringify(ready)})) await new Promise((r) => setTimeout(r, 20));
await shutdown({ graceMs: 300 });
console.log("after-shutdown " + child.signalCode);
process.exit(130);
`,
    );
    const res = spawnSync(process.execPath, [host], { encoding: "utf8", timeout: 15_000 });
    assert.equal(res.stdout.trim(), `after-shutdown ${signal}`, `marker missing; stderr: ${res.stderr}`);
    assert.equal(res.status, 130);
  });
}

/** The shape a real host has, and the one that also trips Bun: a SIGINT handler
 *  that closes the host's own handle (a timer here: a real server's `close()`
 *  happens to keep Bun alive), then awaits `shutdown()`, logs and exits 130. */
for (const [label, script, signal] of [
  ["obeys SIGTERM", `echo 1 > "$READY"; exec sleep 300`, "SIGTERM"],
  ["ignores SIGTERM", `trap "" TERM; echo 1 > "$READY"; exec sleep 300`, "SIGKILL"],
] as const) {
  test(`a SIGINT handler that awaits shutdown() runs to its own exit code (child ${label})`, async () => {
    const dir = tmp();
    const ready = join(dir, "ready");
    const host = join(dir, "handler.mjs");
    writeFileSync(
      host,
      `import { existsSync } from "node:fs";
import { shutdown, spawnGroup } from ${JSON.stringify(new URL("./process-group.js", import.meta.url).href)};
const child = spawnGroup("sh", ["-c", ${JSON.stringify(script)}], { stdio: "ignore", env: { ...process.env, READY: ${JSON.stringify(ready)} } });
child.unref();
const own = setInterval(() => {}, 1000);
process.on("SIGINT", async () => {
  clearInterval(own);
  await shutdown({ graceMs: 300 });
  console.log("after-shutdown " + child.signalCode);
  process.exit(130);
});
while (!existsSync(${JSON.stringify(ready)})) await new Promise((r) => setTimeout(r, 20));
console.log("ready");
`,
    );
    const proc = spawn(process.execPath, [host], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const closed = new Promise<number | null>((r) => proc.once("close", (code) => r(code)));
    await waitFor(() => out.includes("ready"));
    proc.kill("SIGINT");
    const code = await closed;
    assert.equal(out.replace("ready", "").trim(), `after-shutdown ${signal}`, `marker missing; stderr: ${err}`);
    assert.equal(code, 130);
  });
}
