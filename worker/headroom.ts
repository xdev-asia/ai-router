import { parseModel } from "./providers";
import type { Upstream } from "./proxy";

/**
 * Headroom (https://github.com/chopratejas/headroom), the way 9router calls it: POST `{messages, model}` in
 * OpenAI shape to `<url>/v1/compress`, get `{messages}` back, shorter. Fail-open: on any failure, or an answer
 * that is not the same messages in the same roles, the request goes on unchanged. The endpoint takes no key,
 * and it receives the conversation: point it only at a Headroom you run.
 */
const TIMEOUT_MS = 3000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export async function headroomCompress(upstream: Upstream, url: string, body: Json): Promise<Json> {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return body;
  const ref = parseModel(body.model);
  const model = ref?.kind === "target" ? ref.target.model : body.model;
  let res: Response;
  try {
    res = await upstream(
      new Request(url.replace(/\/+$/, "") + "/v1/compress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, model }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
  } catch {
    return body;
  }
  if (!res.ok) return body;
  const data = (await res.json().catch(() => null)) as { messages?: unknown } | null;
  const out = data?.messages;
  const sameShape = Array.isArray(out) && out.length === messages.length && out.every((m, i) => isObj(m) && isObj(messages[i]) && m.role === (messages[i] as Json).role);
  return sameShape ? { ...body, messages: out } : body;
}
