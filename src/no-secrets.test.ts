import { test } from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT, scanTextFiles } from "./repo-scan.test.js";

/** API keys live in the environment, never in a file. This is the guard that
 *  makes that a checked fact rather than a habit: a key pasted into a fixture,
 *  a README example or a test double fails the build instead of reaching a
 *  repository, where deleting it later does not un-publish it.
 *
 *  **It walks every text file, including dotfiles.** It used to require a known
 *  extension, which made `.env`, `.env.local` and `.npmrc` invisible to the one
 *  guard whose entire purpose is that a key never reaches a versioned file --
 *  `.npmrc` especially, since an auth token there is the standard way a registry
 *  credential leaks. The walk is shared with the language guard now (see
 *  `repo-scan.test.ts`) so the two file sets cannot drift apart again, which is
 *  how this hole opened in the first place.
 *
 *  `.gitignore` carries `.env*` and `.npmrc` as well. A guard that catches a
 *  committed key is already too late; the ignore rule stops it being
 *  committable, and the two together are the actual answer.
 *
 *  **What these patterns do NOT cover, declared rather than left to look like
 *  coverage.** This is a shape matcher, and naming its edge is the difference
 *  between a limit and a defect.
 *
 *  Not matched, and a deliberate choice rather than an oversight: PEM private
 *  key blocks, `Authorization: Bearer` headers, JWTs, Azure connection strings,
 *  GCP service-account JSON, AWS access keys, Stripe and Slack tokens. Each is a
 *  distinct shape, and adding shapes indefinitely turns a guard into a
 *  half-maintained catalogue; these are the credentials this project actually
 *  handles.
 *
 *  And three classes **no matcher of this kind can see, by construction**:
 *  a key assembled by concatenation (the trick this very file uses on itself),
 *  a base64-encoded one, and a hex-encoded one. Nobody should read their absence
 *  as an oversight to fix -- it is not fixable at this layer, and the answer to
 *  it is `.gitignore` plus review, not a longer regex.
 *
 *  The patterns are assembled from fragments on purpose -- spelled out whole,
 *  this file would match itself. */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "anthropic", re: new RegExp("sk" + "-ant-" + "[A-Za-z0-9_-]{24,}") },
  // Hyphens and underscores are INSIDE the class, which the first version got
  // wrong: it required 32+ contiguous alphanumerics after the prefix, so
  // today's segmented OpenAI keys broke the run at the segment separator and
  // passed entirely. Same cause would have let OpenRouter's segmented form
  // through. The header said "openai" while covering only the retired shape.
  { name: "openai", re: new RegExp("\\b" + "sk" + "-[A-Za-z0-9_-]{32,}\\b") },
  { name: "google", re: new RegExp("\\b" + "AI" + "za[A-Za-z0-9_-]{30,}\\b") },
  { name: "github", re: new RegExp("\\b" + "gh" + "[pousr]" + "_[A-Za-z0-9]{30,}\\b") },
  // The registry credential. This package publishes to npm, and an auth token
  // in `.npmrc` is how that leaks -- which is also why
  // `.gitignore` names `.npmrc` rather than relying on this alone.
  { name: "npm", re: new RegExp("\\b" + "npm" + "_[A-Za-z0-9]{36}\\b") },
];

const SELF = "src/no-secrets.test.ts";

test("no API-key-shaped value appears in any versioned file", () => {
  const files = scanTextFiles(REPO_ROOT, [SELF]);

  // Premise: a guard that scans nothing passes for the wrong reason.
  assert.ok(files.length > 10, `expected to scan the repository, scanned ${files.length} files`);

  const hits: string[] = [];
  for (const { rel, text } of files) {
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) hits.push(`${name}-shaped value in ${rel}`);
    }
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

/** The coverage that was missing, proven against a temporary tree: a key in a
 *  file the old extension list could not see. `.env` failed the list and was not
 *  extensionless either, so it was invisible to both guards at once. */
test("a key planted in a dotfile or an extensionless file is caught", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = mkdtempSync(join(tmpdir(), "llm-adapters-secrets-"));
  const key = "sk" + "-ant-" + "api03-" + "A".repeat(32);
  for (const name of [".env", ".env.local", ".npmrc", "LICENSE", "NOTES"]) {
    writeFileSync(join(root, name), `SOME_KEY=${key}\n`);
  }

  const caught = scanTextFiles(root)
    .filter(({ text }) => PATTERNS.some(({ re }) => re.test(text)))
    .map((f) => f.rel)
    .sort();

  assert.deepEqual(caught, [".env", ".env.local", ".npmrc", "LICENSE", "NOTES"]);
});

/** The gap qa named, and it is the sharpest one: **this guard scans versioned
 *  files, and `dist/` is gitignored — so the only thing that actually ships was
 *  the only thing no guard read.** The pack gate checks the *shape* of what is
 *  published (names and extensions); nothing checked the bytes. A key in
 *  `dist/secrets.js` passed both.
 *
 *  Closing it by content rather than by enumerating bad filenames is the same
 *  lesson the pack gate itself had to learn. The patterns are the ones above,
 *  not a second copy: a duplicated security pattern is one that drifts. */
test("nothing the package publishes carries a key-shaped value", async () => {
  const { join } = await import("node:path");
  const published = scanTextFiles(join(REPO_ROOT, "dist"));

  // Premise: this runs against a build. An empty `dist/` would pass vacuously,
  // and `npm test` builds first precisely so it cannot.
  assert.ok(published.length > 10, `expected a built dist/, scanned ${published.length} files`);

  const hits: string[] = [];
  for (const { rel, text } of published) {
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) hits.push(`${name}-shaped value in dist/${rel}`);
    }
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

// The guard has to be able to fail, or its green means nothing.
test("the patterns actually match a key of each shape", () => {
  const samples = [
    "sk" + "-ant-" + "api03-" + "A".repeat(24),
    "sk" + "-" + "B".repeat(40),
    "AI" + "za" + "C".repeat(33),
    "gh" + "p" + "_" + "D".repeat(36),
    "npm" + "_" + "E".repeat(36),
  ];
  for (const [i, sample] of samples.entries()) {
    assert.ok(PATTERNS[i]!.re.test(sample), `${PATTERNS[i]!.name} pattern failed to match its own sample`);
  }
});

/** The segmented shapes, which are what the providers issue now and what the
 *  first version of the `openai` pattern let through completely. Kept as their
 *  own test because "the pattern matches a sample" passed while this did not --
 *  the sample was the retired format. */
test("segmented keys are matched, not just the old unsegmented shape", () => {
  const anyPattern = (s: string) => PATTERNS.some(({ re }) => re.test(s));
  assert.ok(anyPattern("sk" + "-proj-" + "A".repeat(40)), "a segmented OpenAI project key passed");
  assert.ok(anyPattern("sk" + "-or-v1-" + "b".repeat(48)), "a segmented OpenRouter key passed");
  assert.ok(anyPattern("sk" + "-svcacct-" + "C".repeat(40)), "a segmented service-account key passed");

  // And the guard still has a floor: ordinary prose must not trip it.
  for (const innocent of ["sk-", "npm install", "the sk-ant prefix", "gh_"]) {
    assert.ok(!anyPattern(innocent), `false positive on: ${innocent}`);
  }
});
