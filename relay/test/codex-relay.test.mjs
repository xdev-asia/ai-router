// Tests for the Codex relay. A fake upstream stands in for chatgpt.com; no real token anywhere.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { createRelay } from "../codex-relay.mjs";

const SECRET = "test-relay-secret-0123456789abcdef";

/** A local server that records each request and answers with `reply`. */
function fakeUpstream() {
  const u = { calls: [], reply: (_req, res) => res.end("{}") };
  u.server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    u.calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    u.reply(req, res);
  });
  return u;
}

const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${server.address().port}`)));

describe("codex relay", () => {
  const up = fakeUpstream();
  const logs = [];
  let relay;
  let base;

  before(async () => {
    const upBase = await listen(up.server);
    relay = createRelay({ secret: SECRET, upstream: `${upBase}/backend-api/codex/responses`, log: (line) => logs.push(line), maxBody: 1024 });
    base = await listen(relay);
  });
  after(() => {
    relay.close();
    up.server.close();
  });
  beforeEach(() => {
    up.calls.length = 0;
    logs.length = 0;
    up.reply = (_req, res) => res.end("{}");
  });

  const send = (headers = {}, body = '{"model":"gpt-5.2-codex"}', path = "/codex/responses", method = "POST") =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : body });

  it("refuses a request without the secret, or with a wrong one, with 403 and x-relay-error, and sends nothing on", async () => {
    for (const headers of [{}, { "x-relay-secret": "wrong" }, { "x-relay-secret": SECRET + "x" }]) {
      const res = await send(headers);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("x-relay-error"), "relay_unauthorized");
      assert.deepEqual(await res.json(), { error: "relay_unauthorized" });
    }
    assert.equal(up.calls.length, 0);
  });

  it("sends the request on with only the Codex headers, and the body as it came", async () => {
    const res = await send({
      "x-relay-secret": SECRET,
      authorization: "Bearer at-fake",
      accept: "text/event-stream",
      originator: "codex_cli_rs",
      "user-agent": "codex_cli_rs/0.167.1",
      version: "0.167.1",
      session_id: "s-1",
      "chatgpt-account-id": "acc_1",
      cookie: "a=b",
      "cf-worker": "example.com",
      "x-forwarded-for": "10.0.0.1",
    });
    assert.equal(res.status, 200);
    assert.equal(up.calls.length, 1);
    const sent = up.calls[0];
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/backend-api/codex/responses");
    assert.equal(sent.body, '{"model":"gpt-5.2-codex"}');
    assert.equal(sent.headers.authorization, "Bearer at-fake");
    assert.equal(sent.headers["chatgpt-account-id"], "acc_1");
    assert.equal(sent.headers.originator, "codex_cli_rs");
    assert.equal(sent.headers["user-agent"], "codex_cli_rs/0.167.1");
    assert.equal(sent.headers.session_id, "s-1");
    for (const dropped of ["x-relay-secret", "cookie", "cf-worker", "x-forwarded-for"]) assert.equal(sent.headers[dropped], undefined, dropped);
  });

  it("passes the answer back as a stream, with its status and the useful headers only", async () => {
    up.reply = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "12", "set-cookie": "s=1", "retry-after": "3" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 20);
    };
    const res = await send({ "x-relay-secret": SECRET });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("x-codex-primary-used-percent"), "12");
    assert.equal(res.headers.get("retry-after"), "3");
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(await res.text(), "data: one\n\ndata: two\n\n");
  });

  it("passes an upstream refusal on with its status and body", async () => {
    up.reply = (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"detail":"The usage limit has been reached"}');
    };
    const res = await send({ "x-relay-secret": SECRET });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { detail: "The usage limit has been reached" });
  });

  it("serves only POST /codex/responses, and GET /health", async () => {
    assert.equal((await send({ "x-relay-secret": SECRET }, "{}", "/other")).status, 404);
    assert.equal((await send({ "x-relay-secret": SECRET }, "{}", "/codex/responses", "PUT")).status, 405);
    const health = await send({}, undefined, "/health", "GET");
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    assert.equal(up.calls.length, 0);
  });

  it("refuses a body over the limit with 413", async () => {
    const res = await send({ "x-relay-secret": SECRET }, "x".repeat(2048));
    assert.equal(res.status, 413);
    assert.equal(up.calls.length, 0);
  });

  it("logs method, path and status only: never the secret, the token or the body", async () => {
    await send({ "x-relay-secret": SECRET, authorization: "Bearer at-fake" }, '{"secret-body":1}');
    await send({ "x-relay-secret": "wrong" });
    assert.ok(logs.length >= 2);
    const all = logs.join("\n");
    for (const hidden of [SECRET, "wrong", "at-fake", "secret-body"]) assert.ok(!all.includes(hidden), hidden);
    assert.match(all, /POST \/codex\/responses 200/);
    assert.match(all, /POST \/codex\/responses 403/);
  });
});

describe("codex relay set-up", () => {
  it("refuses a secret shorter than 32 characters", () => {
    assert.throws(() => createRelay({ secret: "short" }), /RELAY_SECRET/);
    assert.throws(() => createRelay({ secret: undefined }), /RELAY_SECRET/);
  });

  it("answers 502 when the upstream cannot be reached", async () => {
    const relay = createRelay({ secret: SECRET, upstream: "http://127.0.0.1:1/backend-api/codex/responses", log: () => {} });
    const base = await listen(relay);
    try {
      const res = await fetch(base + "/codex/responses", { method: "POST", headers: { "x-relay-secret": SECRET }, body: "{}" });
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: "upstream_unreachable" });
    } finally {
      relay.close();
    }
  });
});
