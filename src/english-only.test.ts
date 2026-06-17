import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPO_ROOT, scanTextFiles } from "./repo-scan.test.js";

/** Everything written in this repository is English — code, comments,
 *  documentation, planning notes and **string literals**.
 *
 *  **What this guard does and does not do, stated honestly, because an earlier
 *  version of this header overstated it and that overstatement was reported
 *  upward as a closed gap.** The Portuguese placeholder that motivated this file
 *  (`SESSAO-HIGIENIZADA`) carries no accent and is not a function word, so
 *  *neither* detector below finds it. Language detection on identifiers and
 *  invented tokens is not a solvable problem with two regexes, and pretending
 *  otherwise is worse than admitting it: a guard trusted past its reach stops
 *  anyone from looking.
 *
 *  So the coverage is split, deliberately:
 *
 *  - The two detectors below catch Portuguese **prose** — the common case, and
 *    the one that arrives by the sentence rather than by the token.
 *  - The fixture's sanitised values are pinned by **exact identity** in the last
 *    test. That is what actually closes the case that started this: put a
 *    Portuguese placeholder back and it fails because the string is not the
 *    expected one, with no language detection involved at all.
 *
 *  **A work artefact left inside the tree is scanned like any other file**, and
 *  there is no exclusion list for scratch output. That was decided rather than
 *  assumed: a "do not count these" list gets extended the first time anything is
 *  inconvenient, which is the same reason a per-line opt-out marker was refused.
 *  A scratch file sitting in the repository really is in the repository, and if
 *  somebody committed it the guard would be right.
 *
 *  A sibling repository has the same rule and a guard enforcing it, and that
 *  guard's own header records that it looks only at `//` and block comments,
 *  never at strings. That gap is how the placeholder reached a commit past two
 *  prose sweeps: in a fixture, the language is data. This one reads whole files,
 *  strings and JSON included — it can afford to, because here nothing written is
 *  Portuguese, so there is no legitimate category to carve out. */

// Latin-1 accented LETTERS. The two gaps in the range are deliberate and were
// found by this guard's own first run: U+00D7 multiplication sign and U+00F7
// division sign sit inside Latin-1 Supplement but are maths, not letters, and a
// plain range flagged three markdown tables writing counts as `21 x 12`. Em
// dash, arrows, ellipsis and README's check marks are outside the block
// entirely, so they never trip it.
const ACCENTED = /[À-ÖØ-öø-ÿ]/;

/** Portuguese function words, matched **case-insensitively** and whole-word.
 *
 *  Case-insensitivity is not cosmetic: the first version was case-sensitive, and
 *  qa walked `NAO QUE PARA` straight through it.
 *
 *  Three words that belong in any Portuguese list are deliberately absent,
 *  because each collides with English or with real content here: `do` is an
 *  English verb, `com` matches inside `api.anthropic.com`, and `de` matches
 *  inside hyphenated identifiers. The accent detector covers the accented half
 *  of the language anyway; this list exists for the unaccented half. */
const PT_WORDS = new RegExp(
  "\\b(" +
    [
      "nao", "que", "para", "uma", "por", "mais", "como", "mas", "ou", "se",
      "ser", "ter", "foi", "isso", "aqui", "quando", "porque", "pelo", "pela",
      "dos", "das", "nos", "nas", "ele", "ela", "seu", "sua", "tem", "fazer",
      "ainda", "depois", "antes", "onde", "quem", "qual", "muito", "cada",
      "entre", "sobre", "sem", "vez", "pode", "deve", "precisa", "sao", "esta",
      // `suite` is absent for the same reason as `do` and `com`: it is an
      // English word, and this repository writes it constantly. The Portuguese
      // spelling carries an accent, so the detector above already has it.
      "estao", "tambem", "entao", "diretorio", "arquivo", "medido",
    ].join("|") +
    ")\\b",
  "i",
);

/** Inline code spans are stripped before the ACCENT scan only, and only when the
 *  span is not prose.
 *
 *  The exemption exists because explaining why the naive Latin-1 range was the
 *  wrong character class requires quoting the accented range, and a guard that
 *  stops you documenting a character bug is the instrument bending the record.
 *
 *  **The rule is "no run of three or more LETTERS", and accented characters
 *  count as letters.** They did not, at first, and that was a real hole: an
 *  accented character is not `[A-Za-z]`, so a lone accented word inside
 *  backticks was a string of one-letter runs, matched the code-span pattern and
 *  was stripped. A character class is exempt because its accented characters
 *  sit alone between brackets and dashes; a word is not exempt because its
 *  letters sit together. That distinction is the whole exemption, and keying it
 *  on ASCII missed it.
 *
 *  The test below is written against the rule rather than an example, which is
 *  how the hole survived the first time: the original case put two words in the
 *  span, and the second word's ASCII letters failed the pattern for a reason
 *  that had nothing to do with the accented one.
 *
 *  **Declared, not chased: this exemption is defeatable and stays that way.**
 *  The rule counts *contiguous* letters, so interleaving any non-letter breaks
 *  a run of any length -- a hyphenated Portuguese word inside backticks reads
 *  as ordinary kebab-case and passes. Accented tokens of one and two letters
 *  pass for the same reason.
 *
 *  Closing that would mean an exemption that tries to tell prose from an
 *  identifier, which is language detection inside the escape hatch itself --
 *  chasing the same problem somewhere worse, with more code and a longer list
 *  of special cases. What actually protects the case this guard was built for
 *  is the exact-identity assertion on the fixture's placeholders, not this
 *  detector. So the limit is written down and left alone. */
const LETTERS = /[A-Za-zÀ-ÖØ-öø-ÿ]{3,}/;
const stripCode = (line: string) => line.replace(/`([^`]*)`/g, (span, inner: string) => (LETTERS.test(inner) ? span : ""));

const SELF = "src/english-only.test.ts";

test("every file in the repository is written in English, strings and JSON included", () => {
  const files = scanTextFiles(REPO_ROOT, [SELF]);

  // Premise: a guard that scans nothing passes for the wrong reason.
  assert.ok(files.length > 10, `expected to scan the repository, scanned ${files.length} files`);

  const offenders: string[] = [];
  for (const { rel, text } of files) {
    text.split("\n").forEach((line, i) => {
      if (ACCENTED.test(stripCode(line))) offenders.push(`${rel}:${i + 1} accented: ${line.trim().slice(0, 90)}`);
      else if (PT_WORDS.test(line)) offenders.push(`${rel}:${i + 1} portuguese: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], `\n${offenders.join("\n")}`);
});

// The guard has to be able to fail, and every hole qa found has to stay shut.
test("the detectors match what they claim to, and the closed holes stay closed", () => {
  assert.ok(ACCENTED.test(stripCode("sessao".replace("sao", "são"))), "accent detector missed an accented word");
  assert.ok(PT_WORDS.test("o teste que falhou"), "word detector missed a Portuguese word");
  assert.ok(PT_WORDS.test("NAO QUE PARA"), "word detector is case-sensitive again");
  assert.ok(PT_WORDS.test("o arquivo medido"), "word list shrank");

  // The code-span exemption covers character classes, not words. Tested against
  // the rule: a lone accented word is the case that used to escape, because its
  // letters are not `[A-Za-z]` and it looked like a run of one-letter tokens.
  assert.equal(stripCode("the class `[À-ÿ]` is too broad"), "the class  is too broad");
  assert.equal(stripCode("the class `[À-ÖØ-öø-ÿ]` is right"), "the class  is right");
  assert.ok(ACCENTED.test(stripCode("a `não` on its own")), "a lone accented word in backticks escaped");
  assert.ok(ACCENTED.test(stripCode("a `não existe` in backticks")), "prose in backticks escaped the accent scan");
  assert.ok(ACCENTED.test(stripCode("a sessão beside `[À-ÿ]`")), "prose beside a code span escaped");
  // And an ASCII word in backticks is kept too -- harmless, since it is English,
  // but it means the exemption is narrow rather than "anything in backticks".
  assert.equal(stripCode("run `opencode models` first"), "run `opencode models` first");

  for (const english of [
    "the model the provider says it used",
    "an empty list, never a throw",
    "https://api.anthropic.com/v1/messages",
    "parameters, paragraphs and Christmas",
    "do not spread process.env",
    "the suite runs on both runtimes",
  ]) {
    assert.ok(!ACCENTED.test(stripCode(english)) && !PT_WORDS.test(english), `false positive on: ${english}`);
  }
});

/** The assertion that actually pins the thing we care about.
 *
 *  Language detection will always leak on invented tokens — `SESSAO-HIGIENIZADA`
 *  has no accent and is nobody's function word. An exact-shape assertion cannot
 *  leak: the sanitised fixture has exactly two placeholder values, and they are
 *  either these strings or the test is red. Put a Portuguese one back and this
 *  fails on identity, with no language detection involved.
 *
 *  It doubles as the sanitisation check: if a real `session_id` or `uuid` ever
 *  replaces a placeholder, that is the same red. */
test("the fixture's sanitised values are exactly the expected placeholders", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/claude-code-result.json", import.meta.url), "utf8"),
  ) as Array<Record<string, unknown>>;
  const result = fixture.find((e) => e.type === "result")!;

  assert.equal(result.session_id, "SANITISED-SESSION");
  assert.equal(result.uuid, "SANITISED-UUID");

  /** And nothing machine-specific crept back in alongside them.
   *
   *  The home-directory prefixes are **not** only `/Users/`. This fixture comes
   *  from a real CLI run, and one captured on a CI runner would sit under
   *  `/home/`, in a container under `/root/`, on Windows under a drive letter or
   *  a UNC share -- none of which the first version of this list could see, so it
   *  would have passed green over an equally identifying path.
   *
   *  Declared as NOT covered, because they are a different class of identifier
   *  and a substring check is the wrong instrument for them: hostnames, email
   *  addresses and private IP ranges. A fixture carrying one of those is caught
   *  by review, not by this line. */
  const raw = JSON.stringify(fixture);
  const prefixes = ["/Users/", "/home/", "/root/", "C:\\\\", "\\\\\\\\"];
  const rawEventKeys = ["cwd", "memory_paths", "messaging_socket_path"];
  for (const leak of [...prefixes, ...rawEventKeys]) {
    assert.ok(!raw.includes(leak), `fixture carries "${leak}"`);
  }
});
