// Run by the publish workflow before anything reaches the registry:
//
//   node scripts/check-release.mjs <release tag> <prerelease: true|false>
//
// Three refusals, each with the decision it stands for:
//
// - The tag must be `v` + the `package.json` version. A release tagged v0.2.0
//   over a manifest still saying 0.1.0 would publish the wrong number, and a
//   published version can never be reused.
// - A truthy `private` is refused. The package no longer carries the field, so
//   this only fires if someone adds it back -- and then a release fails here,
//   with the reason, rather than at npm's EPRIVATE after the whole suite.
// - The Release's "pre-release" flag must agree with the version: a suffix
//   (`0.2.0-beta.1`) needs the flag, a plain `x.y.z` must not have it. The
//   workflow picks the `next` dist-tag from the flag, so a disagreement would
//   either make a pre-release `latest` or hide a stable version under `next`.
//   The flag is required as `true` or `false`: a missing one would otherwise
//   read as "stable" and let the first mistake through.
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
const prerelease = process.argv[3];
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
if (prerelease !== "true" && prerelease !== "false") {
  problems.push(`pre-release flag is "${prerelease ?? ""}", not true or false, so the dist-tag cannot be chosen.`);
} else if (typeof pkg.version === "string" && pkg.version !== "") {
  // A semver pre-release is a `-` before any `+build` metadata.
  const suffixed = pkg.version.split("+")[0].includes("-");
  if (suffixed && prerelease === "false") {
    problems.push(
      `version ${pkg.version} is a pre-release but the GitHub Release is not marked as one: check "Set as a pre-release", or release a plain x.y.z.`,
    );
  } else if (!suffixed && prerelease === "true") {
    problems.push(
      `the GitHub Release is marked as a pre-release but version ${pkg.version} has no pre-release suffix: uncheck "Set as a pre-release", or version it x.y.z-beta.N.`,
    );
  }
}
// Any truthy value is the lock, as it is for npm: `"private": "true"` as a
// string blocks `npm publish` too, and a strict `=== true` let it through here.
if (pkg.private) {
  problems.push(
    `package.json sets "private", so npm will not publish it. Remove the field in a commit to release.`,
  );
}

if (problems.length > 0) fail(problems);
console.log(
  `check-release: ${pkg.name}@${pkg.version} matches ${tag} (${prerelease === "true" ? "pre-release" : "stable"}), and publishing is allowed.`,
);
