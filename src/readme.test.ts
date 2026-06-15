import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./repo-scan.test.js";

/** The README checked against the code rather than against a reading of it.
 *
 *  Every one of these rules exists because the file broke it: an export section
 *  that named six of seventeen, a test count that was wrong by a factor of
 *  three in a section that itself argued against hand-maintained numbers, a
 *  sentence contradicting another ten lines away, and three relative links to
 *  files the tarball does not ship, all of which 404 on a package page. */

const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");

/** Names exported from the barrel, values and types alike, read from the source
 *  rather than listed here — a list would be the same hand-maintained thing
 *  these rules exist to stop.
 *
 *  **Declared limit:** it reads `export { … }` and `export type { … }` blocks
 *  only. A direct `export const x = 1` would be missed. The barrel uses no such
 *  form — it is a re-export file by construction — so this is a limit rather
 *  than a gap, and it is written down because an unstated limit is the defect
 *  this whole file exists to prevent. */
function exportedNames(): string[] {
  const source = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
  const names: string[] = [];
  for (const match of source.matchAll(/export(?:\s+type)?\s*\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

test("every export is named in the README", () => {
  const names = exportedNames();

  // Premise: a parse that found nothing would make the assertion vacuous.
  assert.ok(names.length > 10, `parsed only ${names.length} exports from index.ts`);

  const missing = names.filter((name) => !new RegExp(`\\b${name}\\b`).test(readme));
  assert.deepEqual(missing, [], `exports absent from the README: ${missing.join(", ")}`);
});

test("the README carries no internal project process", () => {
  const offenders: string[] = [];
  readme.split("\n").forEach((line, i) => {
    // `@todo`, ADR references and numbered decisions are project record. A
    // reader who installed this has no way to resolve any of them.
    if (/@todo|\bADR\b|\bD\d+\b/.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 80)}`);
  });
  assert.deepEqual(offenders, [], `\n${offenders.join("\n")}`);
});

test("every relative link and image points at a file the package ships", () => {
  const shipped = new Set(["./LICENSE", "./CHANGELOG.md", "./README.md", "./package.json"]);
  const offenders: string[] = [];
  for (const match of readme.matchAll(/\]\((\.[^)]*)\)/g)) {
    const target = match[1]!;
    if (!shipped.has(target)) offenders.push(target);
  }
  // Images too, in both syntaxes. The first version of this gate looked only at
  // markdown links, so an `<img src="./assets/...">` — which is exactly what a
  // logo is — would have sailed past it and rendered as a broken image on the
  // package page. Same class of hole as the two already closed here.
  for (const match of readme.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const target = match[1]!;
    if (target.startsWith(".") && !shipped.has(target)) offenders.push(`img ${target}`);
  }
  for (const match of readme.matchAll(/!\[[^\]]*\]\((\.[^)]*)\)/g)) {
    offenders.push(`img ${match[1]!}`);
  }
  // A relative link to something `files` excludes is a 404 on the package page,
  // which is where most readers meet this file.
  assert.deepEqual(offenders, [], `relative links to unshipped files: ${offenders.join(", ")}`);
});

/** No hand-maintained count survives. The file itself argues that a number kept
 *  in step with a build output by hand will drift — it said 18 files, then 20,
 *  and was wrong both times within a day — and then carried a test count that
 *  was wrong by a factor of three. The rule has to apply to the file that
 *  states it. */
test("the README states no countable quantity by hand", () => {
  const offenders: string[] = [];
  readme.split("\n").forEach((line, i) => {
    if (/\b\d+\s+(tests?|files?|exports?|adapters|providers|lines)\b/i.test(line)) {
      offenders.push(`${i + 1}: ${line.trim().slice(0, 80)}`);
    }
  });
  assert.deepEqual(offenders, [], `\n${offenders.join("\n")}`);
});

// The header has to name the package, or the first thing a reader copies is
// wrong. The title said `llm-adapters` while the package was scoped.
test("the README's title is the package name", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { name: string };
  assert.match(readme, new RegExp(`^#\\s+${pkg.name.replace("/", "\\/")}\\s*$`, "m"));
  assert.ok(readme.includes(`npm install ${pkg.name}`), "the install command does not name the package");
});

/** The gate above is one-directional: it proves every export is documented, and
 *  proves nothing about whether a documented name exists.
 *
 *  **That direction is where this entire project started.** The README
 *  documented `listModels()` with a per-provider behaviour table while the
 *  method existed in no `.ts` file anywhere — a feature promised to anyone who
 *  read it and absent from anyone who called it. A gate that only walks
 *  exports-to-README would have stayed green through that. */
test("every name the README declares actually exists in the source", () => {
  const sources = allLibrarySource();

  // Only the API section. Elsewhere a `const` is a local in an example — the
  // quick start declares `adapter` and `messages` — and those are illustration,
  // not a claim about what the package exports.
  const api = readme.slice(readme.indexOf("\n## API"), readme.indexOf("\n## Usage and cost"));
  assert.ok(api.length > 200, "the API section was not found; this test is checking nothing");

  const declared: string[] = [];
  for (const block of api.matchAll(/```ts\n([\s\S]*?)```/g)) {
    for (const m of block[1]!.matchAll(/^\s*(?:export\s+)?(?:function|const|interface|type)\s+([A-Za-z_$][\w$]*)/gm)) {
      declared.push(m[1]!);
    }
  }

  // Premise: a parse finding nothing would pass for the wrong reason.
  assert.ok(declared.length > 5, `parsed only ${declared.length} declarations from the README`);

  const missing = declared.filter((name) => !new RegExp(`\\b(?:function|const|interface|type)\\s+${name}\\b`).test(sources));
  assert.deepEqual(missing, [], `the README declares names that do not exist: ${missing.join(", ")}`);
});

/** The same direction, one level down: a member documented on an interface that
 *  the interface does not have. This is the exact shape of the `listModels`
 *  case, which was a member of `LLMAdapter` in the README and of nothing in the
 *  code. */
test("every interface member the README shows exists on the real interface", () => {
  const types = readFileSync(join(REPO_ROOT, "src/types.ts"), "utf8");

  const offenders: string[] = [];
  for (const block of readme.matchAll(/interface\s+([A-Za-z_$][\w$]*)\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = block;
    const real = types.match(new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!real) continue; // covered by the declaration test above
    for (const member of body!.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??[?:(]/gm)) {
      if (!new RegExp(`\\b${member[1]!}\\b`).test(real[1]!)) offenders.push(`${name}.${member[1]!}`);
    }
  }
  assert.deepEqual(offenders, [], `documented members that do not exist: ${offenders.join(", ")}`);
});

/** Spelled-out numbers, because that is the form somebody reaches for **while
 *  writing careful prose** — which is exactly when a count comes back.
 *
 *  Two exemptions, both deliberate. A digit inside a URL is not a count: a
 *  version in a link is legitimate. And the noun must be **plural**, because
 *  "one provider" is the article rather than a tally — a count of this
 *  package's own things is essentially always plural, and matching the singular
 *  made the gate cry wolf on ordinary English, which is how a gate gets
 *  switched off. "One adapter reports dollars" would pass; that is the declared
 *  cost of not crying wolf. */
test("the README states no countable quantity in words either", () => {
  const WORDS = "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dozen";
  const NOUNS = "tests|files|exports|adapters|providers|lines|types|methods";
  const re = new RegExp(`\\b(?:${WORDS})\\s+(?:${NOUNS})\\b`, "i");

  const offenders: string[] = [];
  readme.split("\n").forEach((line, i) => {
    if (re.test(line.replace(/https?:\/\/\S+/g, ""))) offenders.push(`${i + 1}: ${line.trim().slice(0, 80)}`);
  });
  assert.deepEqual(offenders, [], `\n${offenders.join("\n")}`);
});

// An anchor that points at no heading is a dead link that looks alive, and the
// link gate above only checked file targets.
test("every internal anchor points at a heading that exists", () => {
  // GitHub de-duplicates repeated slugs by appending `-1`, `-2`, and so on --
  // which is not a corner case here: `## Providers` and `### PROVIDERS` produce
  // the same base slug, so the API table's link to the second is `#providers-1`.
  // A set built without that rule rejects a link that works.
  const seen = new Map<string, number>();
  const headings = new Set<string>();
  for (const [, text] of readme.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = text!
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.add(count === 0 ? base : `${base}-${count}`);
  }

  const offenders = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!).filter((anchor) => !headings.has(anchor));
  assert.deepEqual(offenders, [], `anchors with no heading: ${offenders.join(", ")}`);
});

/** Every non-test source file. The first version read three of them and
 *  reported `getLLMAdapter` as non-existent — a gate wrong in the direction
 *  that cries wolf, which is how a gate gets switched off. */
function allLibrarySource(): string {
  const read = (dir: string) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
      .map((f) => readFileSync(join(REPO_ROOT, dir, f), "utf8"))
      .join("\n");
  return read("src") + "\n" + read("src/adapters");
}
