import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./repo-scan.test.js";

/** One mechanical check on the demo's markup, for a defect a unit test cannot
 *  see and a glance at the screen catches instantly — which is exactly how this
 *  one was found, after it had been on screen for a while.
 *
 *  `<p hidden class="flex">` renders. The `hidden` attribute is hidden by the
 *  **browser's** stylesheet, and any author `display` rule beats a UA rule
 *  regardless of specificity, so a Tailwind display class wins and the element
 *  stays visible. Setting `.hidden = true` in JavaScript then does nothing
 *  visible, and the spinner sat there permanently while the state logic above it
 *  was entirely correct.
 *
 *  The file had drifted into using both mechanisms — two elements on the
 *  attribute, one on Tailwind's `hidden` class — and the one on the class was
 *  the one that worked. This pins the working mechanism.
 *
 *  **Declared scope: the slice between `<body` and the module script.** Nothing
 *  lives after it today, but a modal, a `<template>` or a `<noscript>` at the
 *  end of the body is the obvious place for this file to grow, and it is exactly
 *  where a stray `hidden` attribute would survive unseen.
 *
 *  **Declared gap: the rendered result is not tested, only the markup.** This
 *  checks the mechanism, not the effect — it would miss a new way of hiding
 *  something that nobody has thought of. Testing computed style would catch
 *  that, and it was considered and refused: it means a headless DOM dependency
 *  in a package whose **absence of dependencies is a stated feature**, to test a
 *  demo that is not even published. So the rendered state is verified by
 *  looking, which is how the bug this file exists for was found in the first
 *  place. A declared gap is a decision; a silent one is an oversight. */
const html = readFileSync(join(REPO_ROOT, "demo/index.html"), "utf8");
const markup = html.slice(html.indexOf("<body"), html.indexOf('<script type="module">'));

test("the demo never mixes the hidden attribute with a display class", () => {
  const offenders = [...markup.matchAll(/<[^>]*\shidden[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /class="[^"]*\b(flex|grid|block|inline-flex|inline-block|table)\b/.test(tag));

  assert.deepEqual(offenders, [], `these render despite \`hidden\`: ${offenders.join(" ")}`);
});

// Everything that starts out of sight has to use the class, so the show/hide
// path and the initial state agree. A mismatch is invisible until somebody
// looks at the page in the one state nobody tests.
test("what starts hidden starts hidden by class", () => {
  for (const id of ["cancel", "status", "usagePanel"]) {
    const tag = markup.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `#${id} is missing from the demo`);
    assert.match(tag, /class="[^"]*\bhidden\b/, `#${id} does not start hidden by class`);
    assert.ok(!/\shidden[\s>]/.test(tag.replace(/class="[^"]*"/, "")), `#${id} still carries the hidden attribute`);
  }
});
