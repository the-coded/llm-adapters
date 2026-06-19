// A small application built on the package — deliberately outside it.
//
// The design document says the library will never serve HTTP and never frame
// another protocol's wire. This does both, which is exactly why it lives here:
// the SSE framing below is application policy, and keeping it out of `src/` is
// what lets two very different applications use the same adapters.
//
// Self-contained on purpose. A demo whose precondition is hand-editing JSON in
// your home directory is not a demo — somebody trying a library out has no
// `~/.llm-adapters/` and will not create one to evaluate something they have
// not chosen yet. Everything is configured on the page.
//
// No framework and no dependency: `node:http`, and Tailwind from a CDN in the
// page.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  getLLMAdapter,
  loadConfig,
  saveConfig,
  registerSecret,
  PROVIDERS,
  PROVIDER_LIST,
  CONFIG_PATH,
} from "@the-coded/llm-adapters";

const PORT = Number(process.env.PORT ?? 4173);
// Loopback only, explicitly. This process now holds an API key in memory and
// serves a page that shows it; binding 0.0.0.0 would hand both to anyone on the
// same network, and the default being convenient is not a reason.
const HOST = "127.0.0.1";
const TIMEOUT_MS = 60_000;

const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");

/** Which fields each provider actually uses. The page renders these and only
 *  these, so nobody is asked for a base URL by a provider that spawns a CLI. */
const FIELDS = {
  anthropic: ["apiKey", "model"],
  "openai-compatible": ["baseUrl", "apiKey", "model"],
  "claude-code": ["claudeCodePath", "model"],
  opencode: ["opencodePath", "model"],
};

/** Configuration lives **in memory, per session, and is never written.**
 *
 *  Not `localStorage`: a key in browser storage outlives the tab, survives a
 *  machine somebody else uses, and is exactly what this package's own security
 *  note argues against. Not a file either, unless somebody clicks Save — which
 *  is the config helper's rule that persisting a secret is a decision written
 *  on purpose, honoured by an application rather than merely documented. */
const sessions = new Map();

const json = (res, status, body) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

/** What this provider needs and does not have, as a sentence. The same answer
 *  the CLI harness gives, rendered in the page rather than thrown at it. */
function missingRequirement(config) {
  if (config.provider === "anthropic" && !config.apiKey) return "an API key";
  if (config.provider === "openai-compatible") {
    if (!config.baseUrl) return "a base URL";
    if (!config.apiKey) return "an API key";
  }
  return null;
}

function configure(session, provider, fields) {
  const config = { provider };
  const held = sessions.get(session)?.[provider] ?? {};
  for (const field of FIELDS[provider] ?? []) {
    const value = fields?.[field];
    // A masked key coming back from the page means "unchanged", not a new
    // value. Writing `sk-…abc` into the config would destroy the real one, and
    // the failure would surface as an authentication error hours later.
    if (field === "apiKey" && typeof value === "string" && value.includes("…")) {
      if (held.apiKey) config.apiKey = held.apiKey;
      continue;
    }
    if (typeof value === "string" && value.trim()) config[field] = value.trim();
  }
  // Registered the moment it arrives, not when an adapter is built: an error
  // raised before that point would otherwise be able to carry it back out.
  registerSecret(config.apiKey);
  sessions.set(session, { ...(sessions.get(session) ?? {}), [provider]: config });
  return config;
}

const configFor = (session, provider) => sessions.get(session)?.[provider] ?? { provider };

/** A key shown as evidence that it exists, never as its value. Neither the
 *  screen nor the HTML source ever carries the real thing. */
const maskKey = (key) => (key.length <= 8 ? "•".repeat(key.length) : `${key.slice(0, 3)}…${key.slice(-3)}`);

const masked = (config) => {
  const { apiKey, provider, ...rest } = config;
  return apiKey ? { ...rest, apiKey: maskKey(apiKey) } : rest;
};

async function stream(req, res, url) {
  const provider = url.searchParams.get("provider");
  const session = url.searchParams.get("session");
  const prompt = url.searchParams.get("prompt") ?? "";
  if (!PROVIDERS[provider]) return json(res, 400, { message: "unknown provider" });

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

  const config = configFor(session, provider);
  const missing = missingRequirement(config);
  if (missing) {
    send(res, "failed", { message: `${PROVIDERS[provider].label} needs ${missing}. Fill it in on the left.` });
    return res.end();
  }

  // The client going away must kill the provider call rather than leave it
  // running for nobody, and nothing may hang: a deadline on every run.
  const aborter = new AbortController();
  running.add(aborter);
  req.on("close", () => aborter.abort());
  const timer = setTimeout(() => aborter.abort(), TIMEOUT_MS);

  try {
    const adapter = getLLMAdapter(config);
    for await (const chunk of adapter.stream("Be concise.", [{ role: "user", content: prompt }], {
      signal: aborter.signal,
      textOnly: true,
      // Provenance travels to the page rather than being flattened here. The
      // page is what must avoid printing an unknown cost as zero.
      onUsage: (usage) => send(res, "usage", usage),
    })) {
      if (chunk.type === "text") send(res, "text", { text: chunk.text ?? "" });
      if (chunk.type === "error") send(res, "failed", { message: chunk.error, details: chunk.details });
    }
    send(res, "done", {});
  } catch (err) {
    send(res, "failed", { message: String(err?.message ?? err) });
  } finally {
    clearTimeout(timer);
    running.delete(aborter);
    res.end();
  }
}

/** The model suggestions, asked of the provider where that is possible.
 *
 *  `claude-code` has no `listModels`, and that is the point rather than a gap:
 *  the page feature-detects, falls back to the static catalogue, and says which
 *  of the two it showed. A present method means a live answer. */
async function models(res, session, provider) {
  if (!PROVIDERS[provider]) return json(res, 400, { message: "unknown provider" });
  const adapter = getLLMAdapter(configFor(session, provider));
  if (!adapter.listModels) {
    return json(res, 200, { models: PROVIDERS[provider].models, live: false });
  }
  const live = await adapter.listModels();
  // An empty list is a normal state — nothing installed, nobody authenticated —
  // so the catalogue stands in and the page says so.
  return json(res, 200, live.length > 0 ? { models: live, live: true } : { models: PROVIDERS[provider].models, live: false });
}

/** In-flight aborters, so a shutdown can cancel what is running rather than
 *  abandon it. This matters more here than in the harness: the demo can be
 *  holding an `opencode serve`, and an orphan of that keeps the port — the next
 *  run then finds a server that is not its own. */
const running = new Set();

/** Ctrl-C has to reach the spawned processes, and since the process-group fix
 *  it does not on its own: `detached` takes a child out of the terminal's
 *  foreground group, so the interrupt lands here and nowhere else. A library
 *  cannot install this — trapping SIGINT is an application deciding its own
 *  shutdown — so it belongs to whoever owns the process. */
function installShutdown(server) {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) process.exit(1);
      shuttingDown = true;
      console.log(`\n${signal} — cancelling ${running.size} in-flight call(s)…`);
      // Aborting propagates into the adapters, which kill their process groups.
      for (const aborter of running) aborter.abort();
      server.close();
      // A grace window so those kills land; exiting immediately would race them
      // and leave behind exactly what the abort exists to remove.
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    } else if (url.pathname === "/providers") {
      // The package's own catalogue, not a copy of it in the page.
      json(res, 200, PROVIDER_LIST.map((p) => ({ ...p, fields: FIELDS[p.id] ?? [] })));
    } else if (url.pathname === "/session" && req.method === "POST") {
      json(res, 200, { session: randomUUID() });
    } else if (url.pathname === "/configure" && req.method === "POST") {
      const { session, provider, fields } = await body(req);
      configure(session, provider, fields);
      // Deliberately does not echo the key back.
      json(res, 200, { ok: true });
    } else if (url.pathname === "/config/load" && req.method === "POST") {
      const { session, provider } = await body(req);
      const stored = loadConfig({ provider });
      if (stored) {
        // The real values go into the session so they can be used; only masked
        // ones go back to the browser. A key that was saved should not have to
        // be re-typed, and it should not be re-printed either.
        sessions.set(session, { ...(sessions.get(session) ?? {}), [provider]: stored });
        registerSecret(stored.apiKey);
      }
      json(res, 200, { found: stored !== null, fields: masked(stored ?? {}), hasApiKey: Boolean(stored?.apiKey) });
    } else if (url.pathname === "/config/save" && req.method === "POST") {
      const { session, provider, includeApiKey } = await body(req);
      saveConfig(configFor(session, provider), { includeApiKey: includeApiKey === true });
      // The path and the mode are reported because they are the only place
      // somebody who never read the code learns them -- and `loadConfig`
      // refuses a looser file, so the day this config is copied to a machine
      // with a different umask, this line is what explains the refusal.
      json(res, 200, { ok: true, path: CONFIG_PATH, mode: "0600", wroteKey: includeApiKey === true });
    } else if (url.pathname === "/models") {
      await models(res, url.searchParams.get("session"), url.searchParams.get("provider"));
    } else if (url.pathname === "/stream") {
      await stream(req, res, url);
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    // Nothing here may take the process down, and no message may carry a key:
    // everything the package returns is redacted, and the key was registered
    // the moment it arrived.
    if (!res.headersSent) json(res, 500, { message: String(err?.message ?? err) });
    else res.end();
  }
}).listen(PORT, HOST, function () {
  installShutdown(this);
  console.log(`demo on http://${HOST}:${PORT}`);
});
