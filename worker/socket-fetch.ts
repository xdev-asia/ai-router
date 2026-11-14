import { connect as cfConnect } from "cloudflare:sockets";

/**
 * One HTTP/1.1 request through an HTTP CONNECT or SOCKS5 proxy, over a raw TCP socket from `cloudflare:sockets`.
 *
 * The Workers `fetch()` cannot use a proxy, and every request it makes carries a `Cf-Worker` header that some
 * upstreams (chatgpt.com among them) refuse. A socket opened with `connect()` carries no such header: this opens a
 * tunnel through the proxy, upgrades it to TLS for the target host with `startTls()`, and speaks HTTP/1.1 itself.
 *
 * Limits that come from Cloudflare, not from this file: a Worker cannot `connect()` to Cloudflare's own IP ranges
 * or to port 25, so a proxy behind Cloudflare, or the target host when it is reached without a proxy, fails here.
 *
 * The response body streams (pull-based, nothing read ahead), so server-sent events arrive as the server sends them.
 */

export interface ProxyTarget {
  kind: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** The part of the `cloudflare:sockets` Socket this file uses. Tests hand in a fake with the same shape. */
export interface TcpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void>;
  startTls(options?: { expectedServerHostname?: string }): TcpSocket;
}

export type Connect = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean },
) => TcpSocket;

/** A proxy that cannot be reached, refuses the tunnel or breaks the protocol. Its message never holds a credential. */
export class ProxyError extends Error {
  override name = "ProxyError";
}

export const defaultConnect: Connect = (address, options) =>
  cfConnect(address, options && { secureTransport: options.secureTransport ?? "off", allowHalfOpen: options.allowHalfOpen ?? false }) as unknown as TcpSocket;

let override: Connect | null = null;

/** Replaces the socket connector for every later call (tests only; null restores `cloudflare:sockets`). */
export function setConnector(c: Connect | null): void {
  override = c;
}

const enc = new TextEncoder();
const HANDSHAKE_MS = 15_000;
const MAX_HEAD = 64 * 1024;
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const CF_LIMITS = "A Cloudflare Worker cannot open sockets to Cloudflare's own IP ranges or to port 25";
const SOCKS_REPLY: Record<number, string> = {
  1: "general failure",
  2: "connection not allowed by the proxy's rules",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** Reads bytes off a stream with a small buffer: exact counts, CRLF lines, or whatever is there. */
class ByteReader {
  private buf: Uint8Array = new Uint8Array(0);
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  get buffered(): number {
    return this.buf.length;
  }

  private async fill(): Promise<boolean> {
    const { done, value } = await this.reader.read();
    if (done) return false;
    if (!value || value.length === 0) return true;
    if (this.buf.length === 0) {
      this.buf = value;
    } else {
      const next = new Uint8Array(this.buf.length + value.length);
      next.set(this.buf);
      next.set(value, this.buf.length);
      this.buf = next;
    }
    return true;
  }

  private take(n: number): Uint8Array {
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async exactly(n: number, what: string): Promise<Uint8Array> {
    while (this.buf.length < n) if (!(await this.fill())) throw new ProxyError(`${what}: the connection closed early`);
    return this.take(n);
  }

  /** Up to `max` bytes, waiting only when nothing is buffered; null at the end of the stream. */
  async some(max: number): Promise<Uint8Array | null> {
    while (this.buf.length === 0) if (!(await this.fill())) return null;
    return this.take(Math.min(max, this.buf.length));
  }

  /** One line without its CRLF; null when the stream ends before any byte of it. */
  async line(max: number, what: string): Promise<string | null> {
    for (let from = 0; ; ) {
      const i = this.buf.indexOf(10, from);
      if (i >= 0) {
        const raw = this.take(i + 1);
        return new TextDecoder().decode(raw.subarray(0, raw.length - (raw[raw.length - 2] === 13 ? 2 : 1)));
      }
      if (this.buf.length > max) throw new ProxyError(`${what}: a line is too long`);
      from = this.buf.length;
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null;
        throw new ProxyError(`${what}: the connection closed early`);
      }
    }
  }

  /** A status line and headers, up to the blank line. */
  async head(what: string): Promise<{ status: number; reason: string; headers: [string, string][] }> {
    let size = 0;
    const first = await this.line(MAX_HEAD, what);
    if (first === null) throw new ProxyError(`${what}: the connection closed before an answer`);
    const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(first);
    if (!m) throw new ProxyError(`${what}: not an HTTP answer`);
    const headers: [string, string][] = [];
    for (;;) {
      const l = await this.line(MAX_HEAD, what);
      if (l === null) throw new ProxyError(`${what}: the connection closed inside the headers`);
      if (l === "") break;
      size += l.length;
      if (size > MAX_HEAD) throw new ProxyError(`${what}: the headers are too large`);
      const c = l.indexOf(":");
      if (c > 0) headers.push([l.slice(0, c).trim().toLowerCase(), l.slice(c + 1).trim()]);
    }
    return { status: Number(m[1]), reason: m[2] ?? "", headers };
  }

  release(): void {
    this.reader.releaseLock();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const isIPv4 = (h: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h) && h.split(".").every((x) => Number(x) <= 255);

function basic(user: string, pass: string): string {
  let bin = "";
  for (const b of enc.encode(`${user}:${pass}`)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function httpConnect(r: ByteReader, w: WritableStreamDefaultWriter<Uint8Array>, proxy: ProxyTarget, host: string, port: number): Promise<void> {
  const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  let head = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
  if (proxy.username !== undefined) head += `Proxy-Authorization: Basic ${basic(proxy.username, proxy.password ?? "")}\r\n`;
  await w.write(enc.encode(`${head}\r\n`));
  const name = `HTTP proxy ${proxy.host}:${proxy.port}`;
  const res = await r.head(name);
  if (res.status === 407)
    throw new ProxyError(`${name} asked for sign-in (407 Proxy Authentication Required): the user name or password is missing or wrong`);
  if (res.status < 200 || res.status > 299) throw new ProxyError(`${name} refused the tunnel to ${authority} (${res.status}${res.reason ? ` ${res.reason}` : ""})`);
}

async function socks5(r: ByteReader, w: WritableStreamDefaultWriter<Uint8Array>, proxy: ProxyTarget, host: string, port: number): Promise<void> {
  const name = `SOCKS5 proxy ${proxy.host}:${proxy.port}`;
  const auth = proxy.username !== undefined;
  await w.write(new Uint8Array(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const [ver, method] = await r.exactly(2, name);
  if (ver !== 5) throw new ProxyError(`${name} does not speak SOCKS5`);
  if (method === 0xff)
    throw new ProxyError(`${name} accepted none of the offered sign-in methods${auth ? "" : " (it may need a user name and password)"}`);
  if (method === 2) {
    if (!auth) throw new ProxyError(`${name} needs a user name and password`);
    const u = enc.encode(proxy.username);
    const p = enc.encode(proxy.password ?? "");
    if (u.length < 1 || u.length > 255 || p.length < 1 || p.length > 255) throw new ProxyError(`${name}: the user name and password must each be 1 to 255 bytes`);
    await w.write(new Uint8Array([1, u.length, ...u, p.length, ...p]));
    const [, status] = await r.exactly(2, name);
    if (status !== 0) throw new ProxyError(`${name} refused the user name or password`);
  } else if (method !== 0) {
    throw new ProxyError(`${name} chose a sign-in method this gateway does not support (${method})`);
  }
  let addr: number[];
  if (isIPv4(host)) {
    addr = [1, ...host.split(".").map(Number)];
  } else {
    const h = enc.encode(host);
    if (h.length > 255) throw new ProxyError(`${name}: the host name is too long`);
    addr = [3, h.length, ...h];
  }
  await w.write(new Uint8Array([5, 1, 0, ...addr, port >> 8, port & 0xff]));
  const rep = await r.exactly(4, name);
  if (rep[0] !== 5) throw new ProxyError(`${name} sent a broken reply`);
  if (rep[1] !== 0) throw new ProxyError(`${name} could not reach ${host}:${port}: ${SOCKS_REPLY[rep[1]!] ?? `reply ${rep[1]}`}`);
  const atyp = rep[3];
  if (atyp === 1) await r.exactly(4 + 2, name);
  else if (atyp === 4) await r.exactly(16 + 2, name);
  else if (atyp === 3) await r.exactly((await r.exactly(1, name))[0]! + 2, name);
  else throw new ProxyError(`${name} sent a broken reply`);
}

function requestBytes(url: URL, method: string, headers: Headers, body: Uint8Array | null): Uint8Array {
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  let head = `${method} ${url.pathname || "/"}${url.search} HTTP/1.1\r\nhost: ${url.hostname}${url.port && url.port !== defaultPort ? `:${url.port}` : ""}\r\n`;
  headers.forEach((value, key) => {
    if (HOP.has(key) || key === "host" || key === "content-length" || key === "accept-encoding") return;
    head += `${key}: ${value}\r\n`;
  });
  head += "accept-encoding: identity\r\nconnection: close\r\n";
  if (body !== null || !["GET", "HEAD", "DELETE", "OPTIONS"].includes(method)) head += `content-length: ${body?.length ?? 0}\r\n`;
  const h = enc.encode(`${head}\r\n`);
  if (!body || body.length === 0) return h;
  const out = new Uint8Array(h.length + body.length);
  out.set(h);
  out.set(body, h.length);
  return out;
}

/**
 * Sends `req` through `proxy` and returns the answer with a streaming body. Throws ProxyError when the proxy cannot
 * be reached or refuses; once the tunnel is up, errors from the target arrive as ordinary HTTP answers.
 */
export async function socketFetch(req: Request, proxy: ProxyTarget, opts: { connect?: Connect; handshakeMs?: number } = {}): Promise<Response> {
  const url = new URL(req.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ProxyError(`cannot send ${url.protocol} through a proxy`);
  const tls = url.protocol === "https:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (tls ? 443 : 80));
  if (proxy.port === 25 || port === 25) throw new ProxyError(`${CF_LIMITS}: port 25 is refused`);
  const method = req.method.toUpperCase();
  const body = req.body ? new Uint8Array(await req.arrayBuffer()) : null;
  const connect = opts.connect ?? override ?? defaultConnect;
  const where = `${proxy.kind === "http" ? "HTTP" : "SOCKS5"} proxy ${proxy.host}:${proxy.port}`;

  let socket: TcpSocket;
  try {
    socket = connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: tls ? "starttls" : "off", allowHalfOpen: false });
  } catch (e) {
    throw new ProxyError(`could not connect to ${where}: ${e instanceof Error ? e.message : "connect failed"}. ${CF_LIMITS}.`);
  }
  let current = socket;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    req.signal?.removeEventListener?.("abort", onAbort);
    current.close().catch(() => undefined);
  };
  function onAbort() {
    finish();
  }
  req.signal?.addEventListener?.("abort", onAbort);

  try {
    // The tunnel: plain bytes to the proxy.
    const hr = new ByteReader(socket.readable.getReader());
    const hw = socket.writable.getWriter();
    try {
      await withTimeout(
        (async () => {
          try {
            await socket.opened;
          } catch (e) {
            throw new ProxyError(`could not connect to ${where}: ${e instanceof Error ? e.message : "connect failed"}. ${CF_LIMITS}.`);
          }
          if (proxy.kind === "http") await httpConnect(hr, hw, proxy, host, port);
          else await socks5(hr, hw, proxy, host, port);
        })(),
        opts.handshakeMs ?? HANDSHAKE_MS,
        () => new ProxyError(`${where} did not answer within ${Math.round((opts.handshakeMs ?? HANDSHAKE_MS) / 1000) || 1} s`),
      );
      if (hr.buffered > 0) throw new ProxyError(`${where} sent bytes after the tunnel opened`);
    } finally {
      hr.release();
      hw.releaseLock();
    }

    // The target: TLS over the tunnel, then HTTP/1.1.
    if (tls) current = socket.startTls({ expectedServerHostname: host });
    const w = current.writable.getWriter();
    await w.write(requestBytes(url, method, req.headers, body));
    w.releaseLock();

    const r = new ByteReader(current.readable.getReader());
    let head = await r.head(`${url.host} through ${where}`);
    while (head.status >= 100 && head.status < 200 && head.status !== 101) head = await r.head(`${url.host} through ${where}`);

    const headers = new Headers();
    for (const [k, v] of head.headers) {
      if (HOP.has(k)) continue;
      try {
        headers.append(k, v);
      } catch {
        // A header Workers will not hold is dropped.
      }
    }
    const te = head.headers.find(([k]) => k === "transfer-encoding")?.[1].toLowerCase() ?? "";
    const cl = head.headers.find(([k]) => k === "content-length")?.[1];
    const noBody = method === "HEAD" || head.status === 204 || head.status === 304 || head.status < 200;
    const init = { status: head.status, statusText: head.reason, headers };
    if (noBody) {
      headers.delete("content-length");
      finish();
      return new Response(null, init);
    }

    const what = `${url.host} through ${where}`;
    let next: () => Promise<Uint8Array | null>;
    if (te.includes("chunked")) {
      headers.delete("content-length");
      let left = 0;
      let crlf = false;
      let done = false;
      next = async () => {
        if (done) return null;
        if (left === 0) {
          if (crlf) {
            await r.exactly(2, what);
            crlf = false;
          }
          const line = await r.line(4096, what);
          if (line === null) throw new ProxyError(`${what}: the body ended early`);
          const size = parseInt(line.split(";")[0]!.trim(), 16);
          if (!Number.isFinite(size) || size < 0) throw new ProxyError(`${what}: a broken chunk`);
          if (size === 0) {
            for (;;) {
              const trailer = await r.line(MAX_HEAD, what);
              if (trailer === null || trailer === "") break;
            }
            done = true;
            return null;
          }
          left = size;
        }
        const chunk = await r.some(left);
        if (chunk === null) throw new ProxyError(`${what}: the body ended early`);
        left -= chunk.length;
        if (left === 0) crlf = true;
        return chunk;
      };
    } else if (cl !== undefined && /^\d+$/.test(cl)) {
      let left = Number(cl);
      next = async () => {
        if (left === 0) return null;
        const chunk = await r.some(left);
        if (chunk === null) throw new ProxyError(`${what}: the body ended early`);
        left -= chunk.length;
        return chunk;
      };
    } else {
      headers.delete("content-length");
      next = () => r.some(64 * 1024);
    }

    let stream = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          try {
            const chunk = await next();
            if (chunk === null) {
              c.close();
              finish();
            } else {
              c.enqueue(chunk);
            }
          } catch (e) {
            c.error(e);
            finish();
          }
        },
        cancel() {
          finish();
        },
      },
      { highWaterMark: 0 },
    );
    const ce = headers.get("content-encoding")?.toLowerCase();
    if (ce === "gzip" || ce === "deflate") {
      stream = stream.pipeThrough(new DecompressionStream(ce) as unknown as TransformStream<Uint8Array, Uint8Array>);
      headers.delete("content-encoding");
      headers.delete("content-length");
    }
    return new Response(stream, init);
  } catch (e) {
    finish();
    if (e instanceof ProxyError) throw e;
    throw new ProxyError(`${where}: ${e instanceof Error ? e.message : "the request failed"}`);
  }
}
