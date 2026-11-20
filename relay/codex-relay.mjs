// Codex relay: forwards the gateway's Codex requests to chatgpt.com from outside Cloudflare.
//
// Why: chatgpt.com answers 403 to any request that carries the `Cf-Worker` header, and a Worker cannot
// leave that header out. The gateway sends Codex requests here instead (CODEX_RELAY_URL), with a shared
// secret; this relay checks it and sends the request on to one fixed upstream. It is not an open proxy: it
// serves a fixed list of paths, each with one method (ROUTES), all under the upstream's /backend-api.
//
// No dependencies: Node 20+ (global fetch). It never logs a header or a body.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

export const CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
/**
 * Relay path → method. The same path under the upstream's /backend-api. The `wham` ones feed the quota page;
 * codex/models the gateway's model sync (the list Codex CLI reads).
 */
const ROUTES = {
  "/codex/responses": "POST",
  "/codex/models": "GET",
  "/wham/usage": "GET",
  "/wham/rate-limit-reset-credits": "GET",
  "/wham/rate-limit-reset-credits/consume": "POST",
};
/** Query parameters passed on, per path; every other one is dropped. */
const QUERY = { "/codex/models": ["client_version"] };
const SECRET_HEADER = "x-relay-secret";
/** Request headers sent on: the ones the gateway's codexHeaders sets. Everything else stays here. */
const REQUEST_HEADERS = ["authorization", "content-type", "accept", "originator", "user-agent", "version", "session_id", "chatgpt-account-id", "openai-beta"];
/** Response headers passed back: the gateway reads these. `x-codex-*` (usage windows) too. */
const RESPONSE_HEADERS = ["content-type", "retry-after"];

const digest = (s) => createHash("sha256").update(String(s)).digest();
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/**
 * @param {{ secret?: string, upstream?: string, log?: (line: string) => void, maxBody?: number }} options
 * @returns {import("node:http").Server}
 */
export function createRelay({ secret, upstream = CODEX_UPSTREAM, log = (line) => console.log(line), maxBody = 32 * 1024 * 1024 } = {}) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("RELAY_SECRET must be set, at least 32 characters");
  const expected = digest(secret);
  const allowed = (given) => typeof given === "string" && timingSafeEqual(digest(given), expected);
  // `upstream` names the responses endpoint; the other routes sit beside it under /backend-api.
  const base = upstream.replace(/\/codex\/responses$/, "");

  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const given = new URL(req.url ?? "/", "http://relay").searchParams;
    const query = new URLSearchParams();
    for (const name of Object.hasOwn(QUERY, path) ? QUERY[path] : []) {
      const value = given.get(name);
      if (value !== null) query.set(name, value);
    }
    const search = query.size ? `?${query}` : "";
    const started = Date.now();
    res.on("finish", () => log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`));

    if (path === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    const method = Object.hasOwn(ROUTES, path) ? ROUTES[path] : null;
    if (!method) return drain(req), json(res, 404, { error: "not_found" });
    if (req.method !== method) return drain(req), json(res, 405, { error: "method_not_allowed" });
    if (!allowed(req.headers[SECRET_HEADER])) return drain(req), json(res, 403, { error: "relay_unauthorized" }, { "x-relay-error": "relay_unauthorized" });

    let body;
    if (method === "POST") {
      body = await readBody(req, maxBody);
      if (!body) return json(res, 413, { error: "body_too_large" });
    } else drain(req);

    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    let up;
    try {
      up = await fetch(base + path + search, { method, headers, body, signal: abort.signal });
    } catch {
      if (!res.headersSent) json(res, 502, { error: "upstream_unreachable" });
      return;
    }

    const out = {};
    for (const [name, value] of up.headers) {
      if (RESPONSE_HEADERS.includes(name) || name.startsWith("x-codex-")) out[name] = value;
    }
    res.writeHead(up.status, out);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body)
      .on("error", () => res.destroy())
      .pipe(res);
  });
}

/** Lets an unread request body go so the connection can answer. */
function drain(req) {
  req.resume();
}

/** The whole body, or null once it passes `max` bytes. */
async function readBody(req, max) {
  if (Number(req.headers["content-length"]) > max) return drain(req), null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return drain(req), null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The shared secret: RELAY_SECRET, else the contents of the file RELAY_SECRET_FILE names (Docker: generated on the
 * first run, see compose.yaml). Undefined when neither is set; createRelay then refuses to start.
 */
export function relaySecret(env, read = (path) => readFileSync(path, "utf8")) {
  if (env.RELAY_SECRET) return env.RELAY_SECRET;
  if (!env.RELAY_SECRET_FILE) return undefined;
  try {
    return read(env.RELAY_SECRET_FILE).trim();
  } catch {
    throw new Error("RELAY_SECRET_FILE cannot be read");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8790);
  const host = process.env.HOST ?? "0.0.0.0";
  const relay = createRelay({ secret: relaySecret(process.env), upstream: process.env.RELAY_UPSTREAM || CODEX_UPSTREAM });
  relay.listen(port, host, () => console.log(`codex relay on ${host}:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => relay.close(() => process.exit(0)));
}
