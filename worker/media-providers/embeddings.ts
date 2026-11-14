/**
 * Embeddings: an OpenAI /v1/embeddings body ({model, input, dimensions, encoding_format}) to Voyage and Jina. Both
 * answer `{data: [{embedding, index}]}` already; the usage is made OpenAI's `{prompt_tokens, total_tokens}`.
 */
import { MediaError, badRequest, jsonResponse, sendJson, type Call, type Result } from "./common";

export type EmbeddingsAdapter = (data: Record<string, unknown>, call: Call) => Promise<Result>;

function inputOf(data: Record<string, unknown>): string | string[] {
  const i = data.input;
  if (typeof i === "string" && i) return i;
  if (Array.isArray(i) && i.length > 0 && i.length <= 1000 && i.every((s) => typeof s === "string")) return i as string[];
  throw badRequest("input: a string or a list of strings");
}

const dimsOf = (data: Record<string, unknown>) => (typeof data.dimensions === "number" && Number.isInteger(data.dimensions) && data.dimensions > 0 ? data.dimensions : null);

type Answer = { data?: unknown; model?: unknown; usage?: { total_tokens?: unknown; prompt_tokens?: unknown } };

function answer(j: Answer, model: string, provider: string): Result {
  if (!Array.isArray(j.data)) throw new MediaError(502, `${provider} answered no embeddings`);
  const u = j.usage ?? {};
  const tokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : typeof u.total_tokens === "number" ? u.total_tokens : 0;
  const total = typeof u.total_tokens === "number" ? u.total_tokens : tokens;
  return { res: jsonResponse({ object: "list", data: j.data, model: typeof j.model === "string" ? j.model : model, usage: { prompt_tokens: tokens, total_tokens: total } }), tokens };
}

const jsonReq = (url: string, key: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });

export const voyageEmbeddings: EmbeddingsAdapter = async (data, call) => {
  const body: Record<string, unknown> = { model: call.model, input: inputOf(data) };
  const dims = dimsOf(data);
  if (dims !== null) body.output_dimension = dims;
  if (data.encoding_format === "base64") body.encoding_format = "base64";
  if (data.input_type === "query" || data.input_type === "document") body.input_type = data.input_type;
  return answer(await sendJson<Answer>(call, jsonReq("https://api.voyageai.com/v1/embeddings", call.key, body), "Voyage AI"), call.model, "Voyage AI");
};

export const jinaEmbeddings: EmbeddingsAdapter = async (data, call) => {
  const input = inputOf(data);
  const body: Record<string, unknown> = { model: call.model, input: typeof input === "string" ? [input] : input };
  const dims = dimsOf(data);
  if (dims !== null) body.dimensions = dims;
  if (typeof data.task === "string" && /^[a-z.-]{1,40}$/.test(data.task)) body.task = data.task;
  if (data.encoding_format === "base64") body.embedding_type = "base64";
  return answer(await sendJson<Answer>(call, jsonReq("https://api.jina.ai/v1/embeddings", call.key, body), "Jina AI"), call.model, "Jina AI");
};
