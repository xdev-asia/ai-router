import type { Hono } from "hono";
import type { AppEnv } from "./env";
import { redact } from "./logs";

/**
 * Request details (observability). While the owner has it on (Settings, off by default), every call to
 * the gateway's API paths keeps what the client sent and the reply it got, with the time to the first streamed
 * chunk and the tokens the reply reported. Never a header: the gateway token is not kept. Bodies are cut to 5 KB
 * and key-like text is masked, as on the Logs page. Only the newest KEEP_DETAILS rows are kept.
 */

export const KEEP_DETAILS = 200;
export const MAX_FIELD = 5 * 1024;
/** How much of a reply is read to put it together; the rest still goes to the client. */
const MAX_CAPTURE = 1024 * 1024;

export interface RequestDetail {
  id: number;
  at: number;
  system_id: string | null;
  model: string | null;
  path: string;
  status: number;
  took_ms: number;
  ttft_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  request: string | null;
  response: string | null;
  thinking: string | null;
}

export async function observabilityOn(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = 'observability'").first<{ value: string }>();
  if (!row) return false;
  try {
    return (JSON.parse(row.value) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

const cut = (s: string): string => {
  const masked = redact(s);
  return masked.length > MAX_FIELD ? masked.slice(0, MAX_FIELD) + "…[cut]" : masked;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface Reply {
  text: string;
  thinking: string;
  input: number;
  output: number;
  cached: number;
}

/** Adds what one JSON body or stream event says (OpenAI chat, Responses, Anthropic or Gemini) to `r`. */
function read(v: unknown, r: Reply, streamed: boolean): void {
  if (!isObj(v)) return;
  // OpenAI chat: a whole message, or a delta.
  if (Array.isArray(v.choices)) {
    const c = v.choices[0];
    const part = isObj(c) ? (streamed ? c.delta : c.message) : null;
    if (isObj(part)) {
      if (typeof part.content === "string") r.text += part.content;
      for (const k of ["reasoning_content", "reasoning"]) if (typeof part[k] === "string") r.thinking += part[k];
    }
  }
  // Anthropic: a whole message, or stream events.
  if (v.type === "message" && Array.isArray(v.content)) {
    for (const b of v.content) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string") r.text += b.text;
      if (b.type === "thinking" && typeof b.thinking === "string") r.thinking += b.thinking;
    }
  }
  if (v.type === "content_block_delta" && isObj(v.delta)) {
    if (typeof v.delta.text === "string") r.text += v.delta.text;
    if (typeof v.delta.thinking === "string") r.thinking += v.delta.thinking;
  }
  if (v.type === "message_start" && isObj(v.message)) read({ usage: v.message.usage }, r, streamed);
  // Responses API.
  if (v.type === "response.output_text.delta" && typeof v.delta === "string") r.text += v.delta;
  if (v.type === "response.reasoning_summary_text.delta" && typeof v.delta === "string") r.thinking += v.delta;
  if (v.object === "response" && !streamed && typeof v.output_text === "string") r.text += v.output_text;
  if (v.type === "response.completed" && isObj(v.response)) read({ usage: v.response.usage }, r, streamed);
  // Gemini.
  if (Array.isArray(v.candidates)) {
    const parts = isObj(v.candidates[0]) && isObj(v.candidates[0].content) ? v.candidates[0].content.parts : null;
    if (Array.isArray(parts)) for (const p of parts) if (isObj(p) && typeof p.text === "string") (p.thought ? (r.thinking += p.text) : (r.text += p.text));
  }
  if (isObj(v.usageMetadata)) {
    const u = v.usageMetadata;
    r.input = num(u.promptTokenCount) || r.input;
    r.output = num(u.candidatesTokenCount) || r.output;
    r.cached = num(u.cachedContentTokenCount) || r.cached;
  }
  // Usage, in any of the shapes above. Streams send it more than once; the last non-zero count wins.
  if (isObj(v.usage)) {
    const u = v.usage;
    const input = num(u.prompt_tokens) || num(u.input_tokens);
    const output = num(u.completion_tokens) || num(u.output_tokens);
    const details = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : isObj(u.input_tokens_details) ? u.input_tokens_details : {};
    const cached = num(details.cached_tokens) || num(u.cache_read_input_tokens);
    if (input) r.input = input;
    if (output) r.output = output;
    if (cached) r.cached = cached;
  }
}

/** The reply text, thinking and tokens in what the client got: a JSON body or a server-sent event stream. */
export function readReply(body: string, streamed: boolean): Reply {
  const r: Reply = { text: "", thinking: "", input: 0, output: 0, cached: 0 };
  if (!streamed) {
    try {
      read(JSON.parse(body), r, false);
    } catch {
      r.text = body;
    }
    return r;
  }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      read(JSON.parse(data), r, true);
    } catch {
      // A line that is not JSON adds nothing.
    }
  }
  return r;
}

interface Capture {
  at: number;
  path: string;
  status: number;
  model: string | null;
  request: string | null;
}

/**
 * Hands back `res` with its body copied as it goes to the client; once the body ends, `save` gets the reply text
 * and when its first chunk came. The client gets every byte, however long the reply.
 */
export function capture(res: Response, startedAt: number, save: (body: string, ttft: number | null, streamed: boolean) => Promise<void>): { res: Response; done: Promise<void> } {
  if (!res.body) return { res, done: save("", null, false) };
  const streamed = (res.headers.get("content-type") ?? "").includes("event-stream");
  const dec = new TextDecoder();
  let body = "";
  let first: number | null = null;
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => (finish = resolve));
  const copy = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      if (first === null) first = Date.now() - startedAt;
      if (body.length < MAX_CAPTURE) body += dec.decode(chunk, { stream: true });
      ctrl.enqueue(chunk);
    },
    flush() {
      finish();
    },
  });
  const out = new Response(res.body.pipeThrough(copy), res);
  // A client that hangs up mid-stream never flushes; the detail is then not written.
  return { res: out, done: ended.then(() => save(body, streamed ? first : null, streamed)) };
}

export async function writeDetail(db: D1Database, c: Capture, systemId: string | null, body: string, ttft: number | null, streamed: boolean): Promise<void> {
  const r = readReply(body, streamed);
  const response = r.text || (streamed ? "" : body);
  if (systemId && !r.input && !r.output) {
    // A stream without `include_usage` tells the client no tokens; the gateway's own usage row for it has them.
    const u = await db
      .prepare("SELECT input_tokens, output_tokens, cache_read_input_tokens AS cached FROM usage WHERE system_id = ? AND at >= ? ORDER BY rowid DESC LIMIT 1")
      .bind(systemId, Math.floor(c.at / 1000))
      .first<{ input_tokens: number; output_tokens: number; cached: number }>()
      .catch(() => null);
    if (u) Object.assign(r, { input: u.input_tokens, output: u.output_tokens, cached: u.cached });
  }
  await db.batch([
    db
      .prepare(
        "INSERT INTO request_detail (at, system_id, model, path, status, took_ms, ttft_ms, input_tokens, output_tokens, cached_tokens, request, response, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(c.at, systemId, c.model, c.path, c.status, Date.now() - c.at, ttft, r.input, r.output, r.cached, c.request === null ? null : cut(c.request), response ? cut(response) : null, r.thinking ? cut(r.thinking) : null),
    db.prepare("DELETE FROM request_detail WHERE id <= (SELECT id FROM request_detail ORDER BY id DESC LIMIT 1 OFFSET ?)").bind(KEEP_DETAILS),
  ]);
}

export function requestDetailRoutes(a: Hono<AppEnv>): void {
  a.get("/observability", async (c) => c.json({ enabled: await observabilityOn(c.env.DB) }));
  a.put("/observability", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!isObj(b) || typeof b.enabled !== "boolean") return c.json({ error: "bad_request", message: "enabled must be true or false" }, 400);
    await c.env.DB.prepare(
      "INSERT INTO setting (key, value, updated_at) VALUES ('observability', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind(JSON.stringify({ enabled: b.enabled }), Math.floor(Date.now() / 1000))
      .run();
    return c.json({ enabled: b.enabled });
  });
  /** Newest first. `model` / `system`: only rows whose model or system contains it. */
  a.get("/request-details", async (c) => {
    const where: string[] = [];
    const binds: string[] = [];
    for (const [q, col] of [
      ["model", "model"],
      ["system", "system_id"],
    ] as const) {
      const v = c.req.query(q)?.trim();
      if (!v) continue;
      where.push(`${col} LIKE ? ESCAPE '\\'`);
      binds.push(`%${v.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    const r = await c.env.DB.prepare(`SELECT * FROM request_detail ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${KEEP_DETAILS}`)
      .bind(...binds)
      .all<RequestDetail>();
    return c.json({ details: r.results, kept: KEEP_DETAILS }, 200, { "cache-control": "no-store" });
  });
  a.get("/request-details/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const row = Number.isInteger(id) ? await c.env.DB.prepare("SELECT * FROM request_detail WHERE id = ?").bind(id).first<RequestDetail>() : null;
    return row ? c.json(row, 200, { "cache-control": "no-store" }) : c.json({ error: "not_found" }, 404);
  });
  a.delete("/request-details", async (c) => {
    await c.env.DB.prepare("DELETE FROM request_detail").run();
    return c.body(null, 204);
  });
}
