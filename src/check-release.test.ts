import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./repo-scan.test.js";

/** `scripts/check-release.mjs` is the publish workflow's last word before the
 *  registry, and the workflow cannot run anywhere but GitHub. So the script is
 *  run here against a manifest of each shape, from a copy placed beside it --
 *  the script reads `../package.json` relative to itself, and giving it a
 *  path argument only for tests would be a second way in. */
function run(manifest: string | null, tag: string): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapters-release-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(REPO_ROOT, "scripts/check-release.mjs"), join(dir, "scripts/check-release.mjs"));
  if (manifest !== null) writeFileSync(join(dir, "package.json"), manifest);
  const res = spawnSync(process.execPath, [join(dir, "scripts/check-release.mjs"), tag], { encoding: "utf8" });
  return { code: res.status, out: res.stdout + res.stderr };
}

const manifest = (fields: Record<string, unknown>) =>
  JSON.stringify({ name: "@the-coded/llm-adapters", version: "1.2.3", ...fields });

/** Every refusal is the script's own line. A stack trace would read as a broken
 *  workflow rather than as a release that was correctly stopped. */
function assertRefused(res: { code: number | null; out: string }, reason: RegExp) {
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, reason);
  assert.ok(res.out.split("\n").filter(Boolean).every((l) => l.startsWith("check-release: ")), `not a clean refusal:\n${res.out}`);
}

test("a matching tag on a manifest without `private` is allowed", () => {
  const res = run(manifest({}), "v1.2.3");
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /publishing is allowed/);
});

test("a tag that is not `v` + the version is refused", () => {
  assertRefused(run(manifest({}), "v1.2.4"), /does not match package\.json version 1\.2\.3/);
  assertRefused(run(manifest({}), "1.2.3"), /does not match/);
  assertRefused(run(manifest({}), ""), /does not match/);
});

// `private` is a lock by truthiness, as it is for npm itself: a string "true"
// blocks `npm publish`, and a strict `=== true` let it through this check.
for (const value of [true, "true", "false", 1]) {
  test(`"private": ${JSON.stringify(value)} is the lock`, () => {
    assertRefused(run(manifest({ private: value }), "v1.2.3"), /sets "private"/);
  });
}

test("a missing package.json is a refusal, not a crash", () => {
  assertRefused(run(null, "v1.2.3"), /cannot read package\.json/);
});

test("an unparsable package.json is a refusal, not a crash", () => {
  assertRefused(run("{ not json", "v1.2.3"), /cannot read package\.json/);
});

test("a package.json that is not an object is a refusal", () => {
  assertRefused(run("null", "v1.2.3"), /not a JSON object/);
  assertRefused(run("[]", "v1.2.3"), /not a JSON object/);
});

test("a missing version is named, not compared as `vundefined`", () => {
  const res = run(JSON.stringify({ name: "x" }), "vundefined");
  assertRefused(res, /has no version/);
  assert.ok(!res.out.includes("vundefined does not"), res.out);
});
