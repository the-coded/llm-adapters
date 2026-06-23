// Run by the publish workflow before anything reaches the registry:
//
//   node scripts/check-release.mjs <release tag>
//
// Two refusals, each with the decision it stands for:
//
// - The tag must be `v` + the `package.json` version. A release tagged v0.2.0
//   over a manifest still saying 0.1.0 would publish the wrong number, and a
//   published version can never be reused.
// - A truthy `private` is refused. The package no longer carries the field, so
//   this only fires if someone adds it back -- and then a release fails here,
//   with the reason, rather than at npm's EPRIVATE after the whole suite.
//
// Every failure goes out as a `check-release:` line, never a stack trace: a
// missing or unparsable manifest, or one without a version, is a refusal like
// the others, not a crash that reads as a broken workflow.

import { readFileSync } from "node:fs";

const fail = (problems) => {
  for (const p of problems) console.error(`check-release: ${p}`);
  process.exit(1);
};

const tag = process.argv[2] ?? "";
const manifest = new URL("../package.json", import.meta.url);

let pkg;
try {
  pkg = JSON.parse(readFileSync(manifest, "utf8"));
} catch (err) {
  fail([`cannot read package.json (${err.code ?? err.message}), so there is nothing to check a release against.`]);
}
if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
  fail(["package.json is not a JSON object, so there is nothing to check a release against."]);
}

const problems = [];
if (typeof pkg.version !== "string" || pkg.version === "") {
  problems.push("package.json has no version, so no release tag can match it.");
} else if (tag !== `v${pkg.version}`) {
  problems.push(
    `release tag "${tag}" does not match package.json version ${pkg.version}: tag the release v${pkg.version}, or bump the version first.`,
  );
}
// Any truthy value is the lock, as it is for npm: `"private": "true"` as a
// string blocks `npm publish` too, and a strict `=== true` let it through here.
if (pkg.private) {
  problems.push(
    `package.json sets "private", so npm will not publish it. Remove the field in a commit to release.`,
  );
}

if (problems.length > 0) fail(problems);
console.log(`check-release: ${pkg.name}@${pkg.version} matches ${tag}, and publishing is allowed.`);
