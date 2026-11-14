import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConnector } from "../socket-fetch";
import { fakeConnector, readRequest, type Peer } from "./fake-socket";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const admin = (up: FakeUpstream, method: string, path: string, body?: unknown) =>
  call(up, `/admin${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const chat = (token: string, body: unknown) => ({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

const USER = "fake-proxy-user";
const PASS = "fake-proxy-pass-not-real-91";
const RELAY_SECRET = "relay-secret-for-tests-0123456789abcdef";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (email: string, account: string) =>
  `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" } }))}.sig`;
const grant = { access_token: "at-1", refresh_token: "rt-1", id_token: idToken("dev@example.com", "acc_1"), expires_in: 3600 };

async function signIn(): Promise<string> {
  const up = fakeUpstream(() => json(grant));
  const start = JSON.parse((await admin(up, "POST", "/oauth/codex/start")).text) as { authorize_url: string };
  const state = new URL(start.authorize_url).searchParams.get("state");
  const finished = await admin(up, "POST", "/oauth/codex/finish", { callback_url: `http://localhost:1455/auth/callback?code=c&state=${state}` });
  expect(finished.res.status, finished.text).toBe(201);
  return (JSON.parse(finished.text) as { id: string }).id;
}

const SSE_EVENTS = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_text.delta", delta: "Hel" },
  { type: "response.output_text.delta", delta: "lo" },
  { type: "response.completed", response: { id: "resp_1", model: "gpt-5.2-codex", usage: { input_tokens: 5, output_tokens: 2 } } },
];
const sseBody = SSE_EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** A SOCKS5 proxy with user/password sign-in in front of a server that runs `server` on the plain HTTP bytes. */
const socksProxy = (server: (peer: Peer) => Promise<void>) => async (peer: Peer) => {
  const greet = await peer.read(2);
  await peer.read(greet[1]!);
  await peer.write([5, 2]);
  const [, ulen] = await peer.read(2);
  const user = new TextDecoder().decode(await peer.read(ulen!));
  const [plen] = await peer.read(1);
  const pass = new TextDecoder().decode(await peer.read(plen!));
  if (user !== USER || pass !== PASS) {
    await peer.write([1, 1]);
    return;
  }
  await peer.write([1, 0]);
  const head = await peer.read(5);
  await peer.read(head[4]! + 2);
  await peer.write([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  await server(peer);
};

beforeEach(reset);
afterEach(() => setConnector(null));

describe("proxy pools with HTTP and SOCKS5 proxies", () => {
  it("takes relays and proxies in one list, keeps proxy passwords sealed and answers only host, port and has_auth", async () => {
    const up = fakeUpstream(() => json({}));
    const r = await admin(up, "POST", "/proxy-pools", {
      name: "Mixed",
      relays: ["https://relay-a.test/", `http://${USER}:${PASS}@proxy.test:8080`, `socks5://${USER}:${PASS}@socks.test`, "http://open.test:3128"],
      secret: RELAY_SECRET,
    });
    expect(r.res.status, r.text).toBe(201);
    expect(r.text).not.toContain(PASS);
    expect(r.text).not.toContain(USER);
    const pool = JSON.parse(r.text);
    expect(pool).toMatchObject({
      name: "Mixed",
      relays: ["https://relay-a.test"],
      proxies: [
        { url: "http://proxy.test:8080", kind: "http", has_auth: true },
        { url: "socks5://socks.test:1080", kind: "socks5", has_auth: true },
        { url: "http://open.test:3128", kind: "http", has_auth: false },
      ],
      hint: "cdef",
    });
    const list = await admin(up, "GET", "/proxy-pools");
    expect(list.text).not.toContain(PASS);
    const row = await env.DB.prepare("SELECT * FROM proxy_pool WHERE id = ?").bind(pool.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(PASS);
    expect(JSON.stringify(row)).not.toContain(USER);
  });

  it("needs the relay secret only when the pool has an https relay", async () => {
    const up = fakeUpstream(() => json({}));
    const proxiesOnly = await admin(up, "POST", "/proxy-pools", { name: "P", relays: ["socks5://socks.test:1080"] });
    expect(proxiesOnly.res.status, proxiesOnly.text).toBe(201);
    expect(JSON.parse(proxiesOnly.text)).toMatchObject({ relays: [], hint: null });
    expect((await admin(up, "POST", "/proxy-pools", { name: "R", relays: ["https://relay.test"] })).res.status).toBe(400);
    const id = JSON.parse(proxiesOnly.text).id;
    expect((await admin(up, "PATCH", `/proxy-pools/${id}`, { relays: ["https://relay.test"] })).res.status).toBe(400);
    expect((await admin(up, "PATCH", `/proxy-pools/${id}`, { relays: ["https://relay.test"], secret: RELAY_SECRET })).res.status).toBe(200);
  });

  it("refuses port 25, other schemes and a broken entry without echoing it", async () => {
    const up = fakeUpstream(() => json({}));
    for (const entry of ["socks5://mail.test:25", "socks4://s.test:1080", "ftp://f.test", `http://${USER}:${PASS}@p.test:8080/path`, "socks5://:1080"]) {
      const r = await admin(up, "POST", "/proxy-pools", { name: "x", relays: [entry] });
      expect(r.res.status, entry).toBe(400);
      expect(r.text).not.toContain(PASS);
    }
    const r = await admin(up, "POST", "/proxy-pools", { name: "x", relays: ["http://mail.test:25"] });
    expect(JSON.parse(r.text).message).toMatch(/port 25/);
  });

  it("an entry typed again without its password keeps the stored one", async () => {
    const up = fakeUpstream(() => json({}));
    const created = JSON.parse((await admin(up, "POST", "/proxy-pools", { name: "S", relays: [`socks5://${USER}:${PASS}@socks.test:1080`] })).text);
    const patched = await admin(up, "PATCH", `/proxy-pools/${created.id}`, { relays: ["socks5://socks.test:1080", "http://other.test:8080"] });
    expect(patched.res.status, patched.text).toBe(200);
    expect(JSON.parse(patched.text).proxies).toEqual([
      { url: "socks5://socks.test:1080", kind: "socks5", has_auth: true },
      { url: "http://other.test:8080", kind: "http", has_auth: false },
    ]);

    let sent = { user: "", pass: "" };
    setConnector(
      fakeConnector(async (peer) => {
        await peer.read(4);
        await peer.write([5, 2]);
        const [, ulen] = await peer.read(2);
        sent.user = new TextDecoder().decode(await peer.read(ulen!));
        const [plen] = await peer.read(1);
        sent.pass = new TextDecoder().decode(await peer.read(plen!));
        await peer.write([1, 1]);
      }).connect,
    );
    // Only the socks entry: the http one would answer differently.
    await admin(up, "PATCH", `/proxy-pools/${created.id}`, { relays: ["socks5://socks.test:1080"] });
    const tested = await admin(up, "POST", `/proxy-pools/${created.id}/test`);
    expect(sent).toEqual({ user: USER, pass: PASS });
    expect(tested.text).not.toContain(PASS);
  });

  it("tests each proxy by opening a tunnel to chatgpt.com, and keeps the answer", async () => {
    const up = fakeUpstream(() => json({}));
    const created = JSON.parse((await admin(up, "POST", "/proxy-pools", { name: "S", relays: [`socks5://${USER}:${PASS}@socks.test:1080`] })).text);
    let head = "";
    const fake = fakeConnector(
      socksProxy(async (peer) => {
        head = (await readRequest(peer)).head;
        await peer.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      }),
    );
    setConnector(fake.connect);
    const r = await admin(up, "POST", `/proxy-pools/${created.id}/test`);
    expect(r.res.status, r.text).toBe(200);
    expect(JSON.parse(r.text).relays).toEqual([{ url: "socks5://socks.test:1080", ok: true, ms: expect.any(Number), status: 200 }]);
    expect(head.startsWith("GET / HTTP/1.1\r\nhost: chatgpt.com\r\n")).toBe(true);
    expect(up.calls).toHaveLength(0);
    const pool = JSON.parse((await admin(up, "GET", "/proxy-pools")).text)[0];
    expect(pool.last_check[0]).toMatchObject({ url: "socks5://socks.test:1080", ok: true });
  });

  it("keeps a proxy failure's reason, with no password in it", async () => {
    const up = fakeUpstream(() => json({}));
    const created = JSON.parse((await admin(up, "POST", "/proxy-pools", { name: "H", relays: [`http://${USER}:${PASS}@proxy.test:8080`] })).text);
    setConnector(() => {
      throw new Error("connection refused");
    });
    const r = await admin(up, "POST", `/proxy-pools/${created.id}/test`);
    const check = JSON.parse(r.text).relays[0];
    expect(check).toMatchObject({ url: "http://proxy.test:8080", ok: false });
    expect(check.error).toMatch(/proxy\.test:8080/);
    expect(r.text).not.toContain(PASS);
  });
});

describe("Codex through a pool proxy", () => {
  const hi = { model: "codex/gpt-5.2-codex", messages: [{ role: "user", content: "hi" }], stream: false };

  async function setup(): Promise<{ token: string; conn: string }> {
    const token = await addSystem("chat");
    await env.DB.prepare("UPDATE system SET allowed_models = '[\"codex/*\"]' WHERE id = 'chat'").run();
    const conn = await signIn();
    const up = fakeUpstream(() => json({}));
    const pool = JSON.parse((await admin(up, "POST", "/proxy-pools", { name: "S", relays: [`socks5://${USER}:${PASS}@socks.test:1080`] })).text);
    const patched = await admin(up, "PATCH", `/connections/${conn}`, { proxy_pool: pool.id });
    expect(patched.res.status, patched.text).toBe(200);
    return { token, conn };
  }

  it("sends the request over a socket through the SOCKS5 proxy, not through the Worker's fetch", async () => {
    const { token } = await setup();
    let request = { head: "", body: "" };
    let tls: string[] = [];
    const fake = fakeConnector(
      socksProxy(async (peer) => {
        request = await readRequest(peer);
        tls = [...peer.tls];
        await peer.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n");
        await peer.write(sseBody);
        await peer.end();
      }),
    );
    setConnector(fake.connect);
    const up = fakeUpstream(() => json({}));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).choices[0].message.content).toBe("Hello");
    expect(up.calls).toHaveLength(0);
    expect(fake.addresses).toEqual([{ hostname: "socks.test", port: 1080 }]);
    expect(tls).toEqual(["chatgpt.com"]);
    expect(request.head.startsWith("POST /backend-api/codex/responses HTTP/1.1\r\n")).toBe(true);
    expect(request.head).toContain("authorization: Bearer at-1\r\n");
    expect(request.head).toContain("chatgpt-account-id: acc_1\r\n");
    expect(request.head).not.toMatch(/x-relay-secret/i);
    expect(JSON.parse(request.body)).toMatchObject({ model: "gpt-5.2-codex" });
    expect(JSON.stringify(await usageRows("chat"))).not.toContain(PASS);
  });

  it("a proxy that cannot be reached answers 502 with the reason, never the password", async () => {
    const { token } = await setup();
    setConnector(() => {
      throw new Error("proxy request failed, cannot connect to the specified address");
    });
    const up = fakeUpstream(() => json({}));
    const { res, text } = await call(up, "/openai/v1/chat/completions", chat(token, hi));
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error.message).toMatch(/socks\.test:1080/);
    expect(text).not.toContain(PASS);
    expect(text).not.toContain(USER);
    expect(up.calls).toHaveLength(0);
    expect(JSON.stringify(await usageRows("chat"))).not.toContain(PASS);
    const logs = await admin(up, "GET", "/logs");
    expect(logs.text).not.toContain(PASS);
  });
});
