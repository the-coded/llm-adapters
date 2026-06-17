// What actually gets published, asserted as an ALLOWLIST.
//
// The first version of this file checked the same names `files` excludes, which
// made it blind in exactly the way `files` is blind: a negation only excludes
// what somebody thought to name. qa smuggled four things past it — a fixture at
// `dist/adapters/fixtures/`, a `.spec.js`, a test under `dist/__tests__/`, and a
// file carrying an API key — none of which matched the patterns being denied.
//
// A gate must not be built the way the thing it guards is built. So this names
// what MAY ship and rejects everything else: unknown artifacts fail by default
// rather than by omission, and a new emit type is a red build instead of a
// silent inclusion.

import { execFileSync } from "node:child_process";

/** Anything under `dist/` must be compiled output or a declaration, and the
 *  root files are the ones npm and GitHub read. Nothing else has a reason to ship:
 *  sourcemaps point at sources we do not publish, fixtures are internal
 *  material, and tests are not a consumer's business. */
const ROOT_FILES = ["README.md", "package.json", "LICENSE", "CHANGELOG.md"];

const allowed = (p) =>
  (p.startsWith("dist/") && (p.endsWith(".js") || p.endsWith(".d.ts"))) || ROOT_FILES.includes(p);

/** Belt to the allowlist's braces. `dist/x.test.js` and `dist/x.spec.js` end in
 *  `.js` and would pass the rule above on their own, so test-shaped and
 *  fixture-shaped paths are named explicitly as well. */
const forbidden = (p) => /\.(test|spec)\./.test(p) || /(^|\/)(tests?|fixtures?|samples?|__tests__|__fixtures__)\//.test(p);

// Shape is all this file can see. The *contents* of everything published are
// scanned for key-shaped values by `src/no-secrets.test.ts`, because a name
// allowlist cannot tell `dist/secrets.js` from any other compiled module -- and
// `dist/` being gitignored is exactly why the repository guard never read it.

// `LICENSE` is required, not merely allowed: `package.json` declares MIT, whose
// one condition is that the notice travels with the code, and a package that
// ships without it is breaking the licence it states. npm includes it
// automatically -- which is how it first arrived here, rejected by this gate,
// which is the gate doing its job on an artifact nobody had named yet.
const REQUIRED = ["dist/index.js", "dist/index.d.ts", "package.json", "README.md", "LICENSE"];

const [{ files }] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const paths = files.map((f) => f.path);

const unexpected = paths.filter((p) => !allowed(p) || forbidden(p));
const missing = REQUIRED.filter((p) => !paths.includes(p));

if (unexpected.length || missing.length) {
  for (const p of unexpected) console.error(`must not be published: ${p}`);
  for (const p of missing) console.error(`must be published but is absent: ${p}`);
  process.exit(1);
}

console.log(`tarball ok: ${paths.length} files, all of them compiled output, declarations, or one of ${ROOT_FILES.join(", ")}`);
