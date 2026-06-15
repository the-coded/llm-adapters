# ADR 0001 — The published contract: compiled output, one entry point, optional capabilities

## Status

Accepted

## Context

A package is installed from `node_modules` by builds it does not control: the
consumer's compiler settings, module resolution and runtime decide whether it
loads at all. What the package ships, where its API begins and ends, how a
capability that not every provider has is expressed, and what an unknown number
looks like are therefore promises, and they bind code that does not exist yet:
the adapters nobody has written, and the Python and Go ports that will have to
honour the same contract.

## Decision

**1. The published artifact is compiled JavaScript plus type declarations, never
TypeScript source.** `tsc` emits `dist/*.js` + `dist/*.d.ts`; internal relative
imports carry `.js` specifiers, which is what `moduleResolution: "nodenext"`
requires. The package's `exports` map points only at `dist/`.

**2. The package has exactly one entry point.** `src/index.ts` re-exports
everything public: `getLLMAdapter`, the provider catalog, the pure functions
`extractUsage` / `readCliOutput`, and every type. Deep paths into the package
are not part of the API, so the file layout inside `src/` is free to change.
That is also why the two pure functions are exported: code that needs to parse
the CLI's output — a test against a recorded sample, say — has no other
supported way to reach them.

**3. A capability not every provider has is an optional method, not a method
that throws.** `listModels?(): Promise<string[]>` is absent on adapters that
cannot ask their provider, so a consumer feature-detects instead of catching.
Where a provider *can* be asked but the answer is unavailable — the binary is
not installed, the user never authenticated — the method resolves to `[]`
rather than rejecting: a machine that has not set a CLI up is a normal state,
not an error.

**4. Unknown is `null`, never `0`, and a provider that does not know stays
silent.** `LLMUsage.costUSD`, `costBasis` **and all four token counts** are
`null` when the provider does not report them, and an adapter with nothing to
report does not invoke `onUsage` at all. Zero and unknown are the same number in
a sum and opposite facts in a spending decision.

A negative `costUSD` is also treated as not reported. It is not a refund this
package knows how to read; it is a malformed number heading into somebody's
spend total, and `null` is the answer that already means "do not add this".

## Consequences

A build step now exists forever, and `dist/` must be current for anything to
run — which is why the CI matrix builds before it tests, on Bun and on Node 22
and 24. Shipping TS source would have been one less moving part and would work
on Bun and Node 24, but it fails for any consumer that cannot strip types inside
`node_modules`, which is all of them by default. That is the tradeoff accepted
here: a build step in exchange for the runtime neutrality the package claims.

Decision 3 is the one a second-language implementation is most likely to get
wrong, because "optional method" has no direct equivalent in every language. The
binding requirement is the *observable* one: a caller must be able to find out
whether discovery is available without triggering an error, and an unavailable
provider must produce an empty list rather than a failure. A port that raises
`NotImplementedError` satisfies the type checker and breaks the contract.

Decision 4 is written here as contract rather than left to each adapter's
judgement because the failure it prevents is silent: an estimate shown as a
bill, or a zero shown as a free call, reads as correct until somebody compares
it with the invoice. It also means `onUsage` firing is evidence and its silence
is information; a future adapter must not add a zero-filled call to look
complete.

The provider catalog in `providers.ts` stays a *suggestion list*, not a limit.
Model fields remain free text everywhere, because which models a CLI can reach
depends on what the person running it authenticated — a constant would be wrong
for everyone but its author.
