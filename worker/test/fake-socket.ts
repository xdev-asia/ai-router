import type { Connect, TcpSocket } from "../socket-fetch";

/**
 * A stand-in for `connect()` from cloudflare:sockets: no network. `serve` plays the proxy and the server behind it
 * on the far end of the socket; TLS is not real (startTls is recorded and the bytes stay plain).
 */
export interface Peer {
  /** Exactly `n` bytes the client wrote. */
  read(n: number): Promise<Uint8Array>;
  /** Bytes up to and including the first blank line, as text. */
  readHead(): Promise<string>;
  write(data: string | number[] | Uint8Array): Promise<void>;
  /** Ends the stream the client reads. */
  end(): Promise<void>;
  /** The host names startTls was called with so far. */
  tls: string[];
}

export interface FakeConnector {
  connect: Connect;
  /** Where each connect() went. */
  addresses: { hostname: string; port: number }[];
  /** Resolves when serve() returns or throws (its error, if any). */
  served: Promise<unknown>;
  closed: () => boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function fakeConnector(serve: (peer: Peer) => Promise<void>): FakeConnector {
  const addresses: { hostname: string; port: number }[] = [];
  let closed = false;
  let servedResolve: (v: unknown) => void = () => undefined;
  const served = new Promise<unknown>((r) => (servedResolve = r));
  const connect: Connect = (address) => {
    addresses.push(address);
    const up = new TransformStream<Uint8Array, Uint8Array>(undefined, { highWaterMark: 64 }, { highWaterMark: 64 });
    const down = new TransformStream<Uint8Array, Uint8Array>(undefined, { highWaterMark: 64 }, { highWaterMark: 64 });
    const reader = up.readable.getReader();
    const writer = down.writable.getWriter();
    let buf = new Uint8Array(0);
    const more = async () => {
      const { done, value } = await reader.read();
      if (done) throw new Error("client closed");
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    };
    const tls: string[] = [];
    const peer: Peer = {
      tls,
      async read(n) {
        while (buf.length < n) await more();
        const out = buf.slice(0, n);
        buf = buf.slice(n);
        return out;
      },
      async readHead() {
        for (;;) {
          const i = dec.decode(buf).indexOf("\r\n\r\n");
          if (i >= 0) {
            const head = dec.decode(buf.slice(0, i + 4));
            buf = buf.slice(enc.encode(head).length);
            return head;
          }
          await more();
        }
      },
      async write(data) {
        await writer.write(typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));
      },
      async end() {
        await writer.close().catch(() => undefined);
      },
    };
    const socket = (): TcpSocket => ({
      readable: down.readable,
      writable: up.writable,
      opened: Promise.resolve({}),
      close: async () => {
        closed = true;
        await writer.close().catch(() => undefined);
      },
      startTls: (o) => {
        tls.push(o?.expectedServerHostname ?? "");
        return socket();
      },
    });
    serve(peer).then(
      () => servedResolve(null),
      (e) => servedResolve(e),
    );
    return socket();
  };
  return { connect, addresses, served, closed: () => closed };
}

/** A CONNECT proxy that checks nothing and answers 200, then hands over to `server`. */
export const httpProxy =
  (server: (peer: Peer, connect: string) => Promise<void>) =>
  async (peer: Peer): Promise<void> => {
    const connect = await peer.readHead();
    await peer.write("HTTP/1.1 200 Connection established\r\n\r\n");
    await server(peer, connect);
  };

/** Reads one HTTP/1.1 request (head and a content-length body). */
export async function readRequest(peer: Peer): Promise<{ head: string; body: string }> {
  const head = await peer.readHead();
  const len = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? "0");
  return { head, body: dec.decode(await peer.read(len)) };
}
