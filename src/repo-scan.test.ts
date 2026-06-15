import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one file walk both repository guards use.
 *
 *  It exists because they had two, and the two drifted. `english-only` was
 *  taught about extensionless files when qa proved it needed to know;
 *  `no-secrets` needed the identical lesson and nobody carried it across. The
 *  result was a set of files visible to one guard and not the other — and
 *  `.env` was visible to **neither**, because it fails an extension list and is
 *  not extensionless either (the leading dot makes `name.includes(".")` true).
 *  A key in a `.env` was the one thing the secrets guard exists to prevent.
 *
 *  One walk, imported by both, is what stops that happening a third time. There
 *  is no extension list at all now: **everything is text until a NUL byte says
 *  otherwise**, which is the only exclusion that cannot go stale as new file
 *  types appear.
 *
 *  It lives in a `.test.ts` file on purpose. The pack gate allows only `.js` and
 *  `.d.ts` under `dist/` and excludes `*.test.*` from the tarball, so a helper
 *  named this way is available to the compiled suite and cannot be published —
 *  without adding a bespoke exclusion to a gate whose whole point is not having
 *  any. */

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

export type ScannedFile = { rel: string; text: string };

/** Every text file under `root`, dotfiles included, as path plus contents. */
export function scanTextFiles(root: string, exclude: readonly string[] = []): ScannedFile[] {
  const skip = new Set(exclude);
  const out: ScannedFile[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      // Normalised: a root with a trailing slash and one without must produce
      // the same relative path, or every caller has to know which it was given.
      const rel = full.slice(root.length).replace(/^[/\\]/, "");
      if (skip.has(rel)) continue;
      const text = readFileSync(full, "utf8");
      // Binary detection follows git's heuristic: a NUL near the start of the
      // file. Scanning the whole file for one meant a single NUL appended
      // anywhere hid the entire file from both guards -- a one-byte way to
      // smuggle a key past the thing that exists to find keys.
      //
      // The window is **8000 UTF-16 code units, not 8000 bytes**. `slice`
      // counts code units, so a file with multibyte characters before the NUL
      // has a window that is physically larger than 8000 bytes. The behaviour is
      // the one that was measured; only the earlier wording was wrong, and a
      // declared limit has to be exact or it is not a declaration.
      //
      // A NUL inside that window still hides a file, which is the declared
      // limit: something whose opening is binary is treated as binary.
      if (text.slice(0, 8000).includes("\0")) continue;
      out.push({ rel, text });
    }
  };

  walk(root);
  return out;
}

/** The names that were invisible before, proven visible now.
 *
 *  Against a temporary tree rather than this repository, because the point is
 *  that the walk *reaches* these shapes — and planting a `.env` in the
 *  repository to prove a guard catches `.env` files is how you commit one. */
test("the walk reaches dotfiles, extensionless files, and unknown extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "llm-adapters-scan-"));
  mkdirSync(join(root, "nested"));
  mkdirSync(join(root, "node_modules"));
  const planted = [".env", ".env.local", ".npmrc", "LICENSE", "NOTES", "Dockerfile", "page.html", "a.ts", "nested/b.json"];
  for (const name of planted) writeFileSync(join(root, name), `content of ${name}\n`);
  writeFileSync(join(root, "node_modules", "dep.js"), "should not be scanned");
  writeFileSync(join(root, "logo.png"), "PNG\0\0binary");
  // A NUL appended past the heuristic window must NOT hide the file.
  writeFileSync(join(root, "sneaky.md"), "x".repeat(9000) + "\0 hidden");

  const seen = scanTextFiles(root).map((f) => f.rel);

  for (const name of planted) assert.ok(seen.includes(name), `the walk missed ${name}`);
  assert.ok(!seen.some((p) => p.startsWith("node_modules")), "node_modules was walked");
  assert.ok(!seen.includes("logo.png"), "a NUL-containing file was treated as text");
  assert.ok(seen.includes("sneaky.md"), "a late NUL byte hid a whole file from the guards");
});

test("the walk reads this repository and honours its exclusions", () => {
  const files = scanTextFiles(REPO_ROOT);
  const names = files.map((f) => f.rel);

  // Premise: a walk that finds nothing makes every guard above it vacuous.
  assert.ok(files.length > 10, `scanned only ${files.length} files`);
  // A dotfile that really exists here, so this is not only tested in a tmpdir.
  assert.ok(names.includes(".gitignore"), "the walk missed .gitignore in the real repository");
  assert.ok(!names.some((p) => p.startsWith("dist/") || p.startsWith("node_modules/")));

  assert.ok(!scanTextFiles(REPO_ROOT, ["package.json"]).map((f) => f.rel).includes("package.json"));
});
