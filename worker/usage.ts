export interface Usage {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export const EMPTY: Usage = { model: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;

/** Overlays the numeric usage fields present in `raw` onto `base`. */
function merge(base: Usage, raw: unknown): Usage {
  const out = { ...base };
  if (raw && typeof raw === "object") {
    for (const f of FIELDS) {
      const v = (raw as Record<string, unknown>)[f];
      if (typeof v === "number" && Number.isFinite(v)) out[f] = v;
    }
  }
  return out;
}

/** Usage of a non-streaming Messages reply. Error bodies have none and give zeros. */
export function usageOfMessage(body: unknown): Usage {
  if (!body || typeof body !== "object") return EMPTY;
  const b = body as { model?: unknown; usage?: unknown };
  return merge({ ...EMPTY, model: typeof b.model === "string" ? b.model : null }, b.usage);
}

/**
 * Reads a Messages SSE stream to the end and returns its usage: `message_start` carries the model and
 * the starting counts, each `message_delta` carries the cumulative counts that changed.
 */
export async function usageOfStream(body: ReadableStream<Uint8Array>): Promise<Usage> {
  let u = EMPTY;
  let buf = "";
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  const line = (raw: string) => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!l.startsWith("data:")) return;
    let ev: { type?: string; message?: { model?: unknown; usage?: unknown }; usage?: unknown };
    try {
      ev = JSON.parse(l.slice(5).trimStart());
    } catch {
      return;
    }
    if (ev.type === "message_start" && ev.message) {
      u = merge({ ...u, model: typeof ev.message.model === "string" ? ev.message.model : u.model }, ev.message.usage);
    } else if (ev.type === "message_delta") {
      u = merge(u, ev.usage);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      line(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) line(buf);
  return u;
}

export interface UsageRow extends Usage {
  system_id: string;
  provider: string;
  request_id: string | null;
  status: number;
  streamed: boolean;
}

export async function recordUsage(db: D1Database, r: UsageRow, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage (system_id, provider, request_id, model, status, streamed,
         input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      r.system_id,
      r.provider,
      r.request_id,
      r.model,
      r.status,
      r.streamed ? 1 : 0,
      r.input_tokens,
      r.output_tokens,
      r.cache_creation_input_tokens,
      r.cache_read_input_tokens,
      nowSec,
    )
    .run();
}

/** [start, end) in unix seconds of a UTC month; `month` is 1-12. */
export function monthRange(year: number, month: number): [number, number] {
  return [Date.UTC(year, month - 1, 1) / 1000, Date.UTC(year, month, 1) / 1000];
}

export function currentMonth(nowMs = Date.now()): { year: number; month: number } {
  const d = new Date(nowMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Tokens a system used this UTC month: input + output + cache write + cache read. */
export async function tokensThisMonth(db: D1Database, systemId: string, nowMs = Date.now()): Promise<number> {
  const { year, month } = currentMonth(nowMs);
  const [start] = monthRange(year, month);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens), 0) AS t
       FROM usage WHERE system_id = ? AND at >= ?`,
    )
    .bind(systemId, start)
    .first<{ t: number }>();
  return row?.t ?? 0;
}
