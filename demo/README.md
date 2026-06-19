# demo

A local page: pick a provider, fill in its fields, and watch a response stream
in with the usage and cost underneath.

```sh
npm run build
node demo/server.mjs      # then open http://127.0.0.1:4173
```

**Self-contained by design.** Nothing has to exist before you open it — no
config file, no environment variable. A demo whose precondition is hand-editing
JSON in your home directory is not a demo: somebody evaluating a library has no
`~/.llm-adapters/` and will not create one for something they have not chosen
yet.

No framework and no build: `node:http` on one side, Tailwind from a CDN on the
other.

## Where the key lives

**In the server's memory, for that session, and never written.** Not in
`localStorage` — a key in browser storage outlives the tab and the person, and
this package's own security note argues against exactly that.

Saving to `~/.llm-adapters/config.json` is a first-class feature and a **click**,
never a side effect of typing in a field. The page reports where it wrote and
with which permission, because a looser mode is refused on read and that message
is the only place somebody who never read the code learns why.

Loading works the same way in reverse. A saved key comes back **masked** —
`sk-…abc`, evidence that it exists rather than its value — and the real one
stays on the server. Sending the mask back means "unchanged"; it never
overwrites the stored key.

The server binds `127.0.0.1` explicitly. It now holds a credential in memory
and serves a page that references it, and binding every interface would hand
both to anyone on the same network.

## What it shows about the library

The provider list, its per-provider fields, and the model suggestions all come
from the package rather than from a copy in the page. The model field is fed by
`listModels()` where the adapter has it and falls back to the static catalogue
where it does not — `claude-code` has no listing command, so the page says so,
which is feature detection working in front of you. The field stays free text
either way: a suggestion, never a limit.

The usage panel reports provenance. A provider that did not say what a call cost
shows **"not reported by the provider — unknown, not zero"**, in its own colour
rather than hidden. That is the distinction the whole package exists to protect,
and a screen that looks good is exactly where it is tempting to print a neat `0`
instead.

Nothing throws and nothing hangs: an unconfigured provider explains what it
needs, and every run carries a deadline.

**Two loading states, not one.** Clicking Send disables the button and shows
*waiting for the first token* immediately; the first chunk turns that into
*receiving* and the text takes over. The distinction is the point rather than
decoration: on a real run `claude-code` spent nearly twelve seconds before its
first token — resolving the binary, building the environment, starting the
process — against about three for an HTTP gateway. Without visible feedback
somebody clicks twice, which is two calls, two charges, and the second answer
overwriting the first.

**Cancel is the `AbortSignal` contract, visible.** It closes the event stream,
the server sees the disconnect, and the adapter's signal kills the spawned
process and its children. Any failure re-enables the button — a page that could
sit disabled forever with a spinner would be a worse bug than the one it
reports.

## The boundary this crosses, said out loud

The library's design document states that it will never serve HTTP and never
format another protocol's wire, because those are application policy — two
applications would reasonably want them to behave differently.

This demo does both. It runs a server and frames `LLMStreamChunk` as
server-sent events. **That is the point of it being here rather than in
`src/`:** it is an application built on the package, the SSE framing lives in
`demo/server.mjs` where an application's concerns belong, none of it is
importable from the package, and none of it ships in the tarball.
