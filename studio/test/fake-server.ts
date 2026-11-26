import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  text: string;
}

export interface Reply {
  status?: number;
  json?: unknown;
  body?: Buffer | string;
  headers?: Record<string, string>;
}

/** A local HTTP server standing in for a platform: records each request and answers what `handle` says. */
export async function fakeServer(handle: (r: Seen, url: string) => Reply | Promise<Reply>): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  let origin = "";
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(parts);
      const r: Seen = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body, text: body.toString("utf8") };
      seen.push(r);
      try {
        const out = await handle(r, origin);
        const headers: Record<string, string> = { ...(out.headers ?? {}) };
        let payload: Buffer | string = out.body ?? "";
        if (out.json !== undefined) {
          payload = JSON.stringify(out.json);
          headers["content-type"] ??= "application/json";
        }
        res.writeHead(out.status ?? 200, headers);
        res.end(payload);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: origin, seen, close: () => new Promise((r) => server.close(() => r())) };
}
