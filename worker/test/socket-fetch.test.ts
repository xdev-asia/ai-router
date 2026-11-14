import { describe, expect, it } from "vitest";
import { ProxyError, socketFetch, type ProxyTarget } from "../socket-fetch";
import { fakeConnector, httpProxy, readRequest, type Peer } from "./fake-socket";

const URL_ = "https://chatgpt.com/backend-api/codex/responses";
const USER = "fake-proxy-user";
const PASS = "fake-proxy-pass-not-real-77";

const post = () =>
  new Request(URL_, {
    method: "POST",
    headers: { authorization: "Bearer fake-at", "content-type": "application/json", "accept-encoding": "gzip, br" },
    body: '{"a":1}',
  });

const httpTarget: ProxyTarget = { kind: "http", host: "proxy.test", port: 8080, username: USER, password: PASS };
const socksTarget: ProxyTarget = { kind: "socks5", host: "socks.test", port: 1080, username: USER, password: PASS };

async function socksHandshake(peer: Peer, auth: boolean): Promise<{ host: string; port: number }> {
  const greet = await peer.read(2);
  const methods = [...(await peer.read(greet[1]!))];
  expect(methods).toEqual(auth ? [0, 2] : [0]);
  await peer.write([5, auth ? 2 : 0]);
  if (auth) {
    const [, ulen] = await peer.read(2);
    const user = new TextDecoder().decode(await peer.read(ulen!));
    const [plen] = await peer.read(1);
    const pass = new TextDecoder().decode(await peer.read(plen!));
    expect([user, pass]).toEqual([USER, PASS]);
    await peer.write([1, 0]);
  }
  const head = await peer.read(5);
  expect([...head.slice(0, 4)]).toEqual([5, 1, 0, 3]);
  const host = new TextDecoder().decode(await peer.read(head[4]!));
  const p = await peer.read(2);
  await peer.write([5, 0, 0, 1, 10, 0, 0, 1, 0x1f, 0x90]);
  return { host, port: (p[0]! << 8) | p[1]! };
}

describe("socketFetch through an HTTP proxy", () => {
  it("opens a CONNECT tunnel with proxy auth, starts TLS for the target and reads a content-length answer", async () => {
    let connectHead = "";
    let request = { head: "", body: "" };
    let tls: string[] = [];
    const fake = fakeConnector(
      httpProxy(async (peer, head) => {
        connectHead = head;
        request = await readRequest(peer);
        tls = [...peer.tls];
        await peer.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}');
      }),
    );
    const res = await socketFetch(post(), httpTarget, { connect: fake.connect });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("connection")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });

    expect(fake.addresses).toEqual([{ hostname: "proxy.test", port: 8080 }]);
    expect(connectHead.startsWith("CONNECT chatgpt.com:443 HTTP/1.1\r\n")).toBe(true);
    expect(connectHead).toContain("Host: chatgpt.com:443\r\n");
    expect(connectHead).toContain(`Proxy-Authorization: Basic ${btoa(`${USER}:${PASS}`)}\r\n`);
    expect(tls).toEqual(["chatgpt.com"]);
    expect(request.head.startsWith("POST /backend-api/codex/responses HTTP/1.1\r\n")).toBe(true);
    expect(request.head).toContain("host: chatgpt.com\r\n");
    expect(request.head).toContain("authorization: Bearer fake-at\r\n");
    expect(request.head).toContain("accept-encoding: identity\r\n");
    expect(request.head).not.toContain("gzip");
    expect(request.head).toContain("connection: close\r\n");
    expect(request.head).toContain("content-length: 7\r\n");
    expect(request.body).toBe('{"a":1}');
    expect(fake.closed()).toBe(true);
  });

  it("sends no Proxy-Authorization when the proxy has no user", async () => {
    let connectHead = "";
    const fake = fakeConnector(
      httpProxy(async (peer, head) => {
        connectHead = head;
        await readRequest(peer);
        await peer.write("HTTP/1.1 204 No Content\r\n\r\n");
      }),
    );
    const res = await socketFetch(new Request("https://api.example.test/x?y=1"), { kind: "http", host: "proxy.test", port: 3128 }, { connect: fake.connect });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(connectHead).not.toMatch(/proxy-authorization/i);
    expect(connectHead.startsWith("CONNECT api.example.test:443 HTTP/1.1")).toBe(true);
  });

  it("turns a 407 into a ProxyError that names the proxy but never the password", async () => {
    const fake = fakeConnector(async (peer) => {
      await peer.readHead();
      await peer.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n");
    });
    const err = await socketFetch(post(), httpTarget, { connect: fake.connect }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyError);
    const msg = (err as Error).message;
    expect(msg).toContain("407");
    expect(msg).toContain("proxy.test:8080");
    expect(msg).not.toContain(PASS);
    expect(msg).not.toContain(USER);
    expect(fake.closed()).toBe(true);
  });

  it("reports any other refusal of the tunnel with its status", async () => {
    const fake = fakeConnector(async (peer) => {
      await peer.readHead();
      await peer.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await expect(socketFetch(post(), httpTarget, { connect: fake.connect })).rejects.toThrow(/403/);
  });
});

describe("socketFetch through a SOCKS5 proxy", () => {
  it("signs in with a user and password, asks for the host by name and decodes a chunked answer", async () => {
    let target = { host: "", port: 0 };
    let request = { head: "", body: "" };
    let tls: string[] = [];
    const fake = fakeConnector(async (peer) => {
      target = await socksHandshake(peer, true);
      request = await readRequest(peer);
      tls = [...peer.tls];
      await peer.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Up: 1\r\n\r\n");
      await peer.write("5;ext=1\r\nHello\r\n");
      await peer.write("7\r\n, world\r\n0\r\nX-Trailer: t\r\n\r\n");
    });
    const res = await socketFetch(post(), socksTarget, { connect: fake.connect });
    expect(res.status).toBe(200);
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(res.headers.get("x-up")).toBe("1");
    expect(await res.text()).toBe("Hello, world");
    expect(target).toEqual({ host: "chatgpt.com", port: 443 });
    expect(tls).toEqual(["chatgpt.com"]);
    expect(request.body).toBe('{"a":1}');
    expect(fake.addresses).toEqual([{ hostname: "socks.test", port: 1080 }]);
  });

  it("offers only no-auth when the proxy has no user", async () => {
    const fake = fakeConnector(async (peer) => {
      await socksHandshake(peer, false);
      await readRequest(peer);
      await peer.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
    const res = await socketFetch(post(), { kind: "socks5", host: "socks.test", port: 1080 }, { connect: fake.connect });
    expect(await res.text()).toBe("ok");
  });

  it("streams an SSE body event by event, before the server has sent the rest", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fake = fakeConnector(async (peer) => {
      await socksHandshake(peer, true);
      await readRequest(peer);
      await peer.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
      const one = "data: one\n\n";
      await peer.write(`${one.length.toString(16)}\r\n${one}\r\n`);
      await gate;
      const two = "data: two\n\n";
      await peer.write(`${two.length.toString(16)}\r\n${two}\r\n0\r\n\r\n`);
    });
    const res = await socketFetch(post(), socksTarget, { connect: fake.connect });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe("data: one\n\n");
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value);
    }
    expect(rest).toBe("data: two\n\n");
  });

  it("reads a body with no length until the server closes", async () => {
    const fake = fakeConnector(async (peer) => {
      await socksHandshake(peer, true);
      await readRequest(peer);
      await peer.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\npart one, ");
      await peer.write("part two");
      await peer.end();
    });
    const res = await socketFetch(post(), socksTarget, { connect: fake.connect });
    expect(await res.text()).toBe("part one, part two");
  });

  it("explains a proxy that accepts none of the offered sign-in methods", async () => {
    const fake = fakeConnector(async (peer) => {
      await peer.read(4);
      await peer.write([5, 0xff]);
    });
    const err = await socketFetch(post(), socksTarget, { connect: fake.connect }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as Error).message).toMatch(/sign-in method/);
    expect((err as Error).message).not.toContain(PASS);
  });

  it("explains a wrong user or password", async () => {
    const fake = fakeConnector(async (peer) => {
      await peer.read(4);
      await peer.write([5, 2]);
      await peer.read(2 + USER.length + 1 + PASS.length);
      await peer.write([1, 1]);
    });
    const err = await socketFetch(post(), socksTarget, { connect: fake.connect }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/user name or password/);
    expect((err as Error).message).not.toContain(PASS);
  });

  it("names the SOCKS5 reply code when the proxy cannot reach the host", async () => {
    const fake = fakeConnector(async (peer) => {
      await peer.read(3);
      await peer.write([5, 0]);
      await peer.read(5 + "chatgpt.com".length + 2);
      await peer.write([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
    });
    await expect(socketFetch(post(), { kind: "socks5", host: "socks.test", port: 1080 }, { connect: fake.connect })).rejects.toThrow(/connection refused/);
  });
});

describe("socketFetch limits", () => {
  it("refuses port 25 before opening a socket", async () => {
    const fake = fakeConnector(async () => undefined);
    await expect(socketFetch(post(), { kind: "http", host: "mail.test", port: 25 }, { connect: fake.connect })).rejects.toThrow(/port 25/);
    expect(fake.addresses).toEqual([]);
  });

  it("explains Cloudflare's connect() limits when the socket cannot open", async () => {
    const connect = () => {
      throw new Error("proxy request failed, cannot connect to the specified address");
    };
    const err = await socketFetch(post(), httpTarget, { connect }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyError);
    const msg = (err as Error).message;
    expect(msg).toContain("proxy.test:8080");
    expect(msg).toMatch(/Cloudflare/);
    expect(msg).not.toContain(PASS);
  });

  it("gives up on a proxy that never answers the handshake", async () => {
    const fake = fakeConnector(() => new Promise<void>(() => undefined));
    await expect(socketFetch(post(), httpTarget, { connect: fake.connect, handshakeMs: 50 })).rejects.toThrow(/did not answer/);
  });
});
