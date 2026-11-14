/**
 * Image generation: an OpenAI /v1/images/generations body ({model, prompt, n, size, response_format}) to each
 * provider's own API; the answer is `{created, data: [{url} | {b64_json}]}`. A provider that answers a URL has the
 * image fetched (without the key) for `b64_json`; one that answers bytes gives `b64_json` whatever was asked.
 * The providers that run a job (BFL, fal, Runway) make one image per request.
 */
import { MediaError, assertHost, badRequest, bytesToB64, imageAsB64, jsonResponse, nearestRatio, poll, safePath, send, sendJson, sizeOf, upstreamError, type Call, type Result } from "./common";
import { minimaxError } from "./speech";

export type ImageAdapter = (data: Record<string, unknown>, call: Call) => Promise<Result>;

type Image = { url: string } | { b64: string };

interface Input {
  prompt: string;
  n: number;
  size: unknown;
  b64: boolean;
}

function inputOf(data: Record<string, unknown>): Input {
  const prompt = data.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) throw badRequest("prompt: what to draw");
  if (prompt.length > 10_000) throw badRequest("prompt: at most 10000 characters");
  const n = data.n === undefined ? 1 : data.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 4) throw badRequest("n: 1 to 4");
  const f = data.response_format;
  if (f !== undefined && f !== "url" && f !== "b64_json") throw badRequest("response_format: url or b64_json");
  return { prompt, n, size: data.size, b64: f === "b64_json" };
}

async function answer(call: Call, input: Input, images: Image[], provider: string): Promise<Result> {
  if (!images.length) throw new MediaError(502, `${provider} answered no image`, { final: true });
  const data = [];
  for (const im of images) {
    if ("b64" in im) data.push({ b64_json: im.b64 });
    else if (input.b64) data.push({ b64_json: await imageAsB64(call, im.url, provider) });
    else data.push({ url: im.url });
  }
  return { res: jsonResponse({ created: Math.floor(Date.now() / 1000), data }) };
}

const jsonReq = (url: string, headers: Record<string, string>, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) });

const one = (input: Input, provider: string) => {
  if (input.n !== 1) throw badRequest(`n: ${provider} makes one image per request`);
};

const BFL_RATIOS = ["1:1", "16:9", "21:9", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3", "9:16", "9:21"];

export const bflImages: ImageAdapter = async (data, call) => {
  const input = inputOf(data);
  one(input, "Black Forest Labs");
  const body: Record<string, unknown> = { prompt: input.prompt };
  if (call.model.includes("ultra")) {
    if (sizeOf(input.size)) body.aspect_ratio = nearestRatio(input.size, BFL_RATIOS);
  } else {
    const s = sizeOf(input.size);
    if (s) Object.assign(body, s);
  }
  const job = await sendJson<{ id?: unknown; polling_url?: unknown }>(call, jsonReq(`https://api.bfl.ai/v1/${safePath(call.model)}`, { "x-key": call.key }, body), "Black Forest Labs");
  const pollUrl = assertHost(
    job.polling_url ?? (typeof job.id === "string" ? `https://api.bfl.ai/v1/get_result?id=${encodeURIComponent(job.id)}` : null),
    ["bfl.ai"],
    "Black Forest Labs",
  );
  const url = await poll<string, { status?: unknown; result?: { sample?: unknown } }>(
    call,
    "Black Forest Labs",
    () => new Request(pollUrl, { headers: { "x-key": call.key, accept: "application/json" } }),
    (j) =>
      j.status === "Ready"
        ? typeof j.result?.sample === "string"
          ? { done: j.result.sample }
          : { fail: "no image in the result" }
        : typeof j.status === "string" && /error|fail|moderated|not found/i.test(j.status)
          ? { fail: j.status }
          : null,
  );
  return answer(call, input, [{ url }], "Black Forest Labs");
};

export const falImages: ImageAdapter = async (data, call) => {
  const input = inputOf(data);
  const body: Record<string, unknown> = { prompt: input.prompt, num_images: input.n };
  const s = sizeOf(input.size);
  if (s) body.image_size = s;
  const auth = { authorization: `Key ${call.key}` };
  const job = await sendJson<{ status_url?: unknown; response_url?: unknown }>(call, jsonReq(`https://queue.fal.run/${safePath(call.model)}`, auth, body), "fal");
  const statusUrl = assertHost(job.status_url, ["fal.run"], "fal");
  const resultUrl = assertHost(job.response_url, ["fal.run"], "fal");
  await poll<true, { status?: unknown; error?: unknown }>(
    call,
    "fal",
    () => new Request(statusUrl, { headers: auth }),
    (j) => (j.status === "COMPLETED" ? (j.error ? { fail: String(j.error) } : { done: true }) : j.status === "FAILED" || j.status === "ERROR" ? { fail: String(j.error ?? "the job failed") } : null),
  );
  const out = await sendJson<{ images?: unknown }>(call, new Request(resultUrl, { headers: auth }), "fal", true);
  const images = Array.isArray(out.images) ? out.images : [];
  return answer(
    call,
    input,
    images.flatMap((im: unknown) => {
      const u = typeof im === "string" ? im : im && typeof im === "object" ? (im as { url?: unknown }).url : null;
      return typeof u === "string" ? [{ url: u }] : [];
    }),
    "fal",
  );
};

const STABILITY_RATIOS = ["1:1", "16:9", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"];

export const stabilityImages: ImageAdapter = async (data, call) => {
  const input = inputOf(data);
  one(input, "Stability AI");
  const endpoint = call.model.includes("ultra") ? "ultra" : call.model.startsWith("sd3") ? "sd3" : "core";
  const f = new FormData();
  f.set("prompt", input.prompt);
  f.set("output_format", "png");
  if (sizeOf(input.size)) f.set("aspect_ratio", nearestRatio(input.size, STABILITY_RATIOS));
  if (endpoint === "sd3") f.set("model", call.model);
  const j = await sendJson<{ image?: unknown; finish_reason?: unknown }>(
    call,
    new Request(`https://api.stability.ai/v2beta/stable-image/generate/${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${call.key}`, accept: "application/json" }, body: f }),
    "Stability AI",
  );
  if (j.finish_reason === "CONTENT_FILTERED") throw new MediaError(400, "Stability AI filtered the image", { final: true });
  if (typeof j.image !== "string") throw new MediaError(502, "Stability AI answered no image");
  return answer(call, input, [{ b64: j.image }], "Stability AI");
};

/** Recraft speaks OpenAI's images API: the body goes as it came, with Recraft's model name. */
export const recraftImages: ImageAdapter = async (data, call) => {
  inputOf(data);
  const j = await sendJson<Record<string, unknown>>(
    call,
    jsonReq("https://external.api.recraft.ai/v1/images/generations", { authorization: `Bearer ${call.key}` }, { ...data, model: call.model }),
    "Recraft",
  );
  return { res: jsonResponse(j) };
};

/** Runway's ratios are in pixels [Unverified: the list in Runway's API reference for gen4_image]. */
const RUNWAY_RATIOS = ["1024:1024", "1920:1080", "1080:1920", "1360:768", "1168:880", "1440:1080", "1080:1440", "1808:768", "2112:912"];
const RUNWAY = "https://api.dev.runwayml.com/v1";

export const runwayImages: ImageAdapter = async (data, call) => {
  const input = inputOf(data);
  one(input, "Runway");
  const headers = { authorization: `Bearer ${call.key}`, "x-runway-version": "2024-11-06" };
  const task = await sendJson<{ id?: unknown }>(call, jsonReq(`${RUNWAY}/text_to_image`, headers, { promptText: input.prompt, model: call.model, ratio: nearestRatio(input.size, RUNWAY_RATIOS) }), "Runway");
  if (typeof task.id !== "string" || !task.id) throw new MediaError(502, "Runway answered no task id", { final: true });
  const url = `${RUNWAY}/tasks/${encodeURIComponent(task.id)}`;
  const outputs = await poll<unknown[], { status?: unknown; output?: unknown; failure?: unknown }>(
    call,
    "Runway",
    () => new Request(url, { headers }),
    (j) =>
      j.status === "SUCCEEDED"
        ? { done: Array.isArray(j.output) ? j.output : [] }
        : j.status === "FAILED" || j.status === "CANCELLED"
          ? { fail: typeof j.failure === "string" ? j.failure : String(j.status) }
          : null,
  );
  return answer(
    call,
    input,
    outputs.filter((u): u is string => typeof u === "string").map((u) => ({ url: u })),
    "Runway",
  );
};

export const huggingfaceImages: ImageAdapter = async (data, call) => {
  const input = inputOf(data);
  one(input, "Hugging Face");
  const res = await send(
    call,
    new Request(`https://router.huggingface.co/hf-inference/models/${safePath(call.model)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${call.key}`, "content-type": "application/json", accept: "image/png" },
      body: JSON.stringify({ inputs: input.prompt }),
    }),
    "Hugging Face",
  );
  if (!res.ok) throw await upstreamError(res, call.key, "Hugging Face");
  if (!(res.headers.get("content-type") ?? "").startsWith("image/")) throw new MediaError(502, "Hugging Face answered no image");
  return answer(call, input, [{ b64: bytesToB64(new Uint8Array(await res.arrayBuffer())) }], "Hugging Face");
};

const MINIMAX_RATIOS = ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"];

export const minimaxImages =
  (host: string): ImageAdapter =>
  async (data, call) => {
    const input = inputOf(data);
    const body = { model: call.model, prompt: input.prompt, aspect_ratio: nearestRatio(input.size, MINIMAX_RATIOS), response_format: input.b64 ? "base64" : "url", n: input.n };
    const j = await sendJson<{ data?: { image_urls?: unknown; image_base64?: unknown }; base_resp?: unknown }>(
      call,
      jsonReq(`https://${host}/v1/image_generation`, { authorization: `Bearer ${call.key}` }, body),
      "MiniMax",
    );
    const err = minimaxError(j.base_resp, "MiniMax");
    if (err) throw err;
    const urls = Array.isArray(j.data?.image_urls) ? j.data.image_urls.filter((u): u is string => typeof u === "string") : [];
    const b64s = Array.isArray(j.data?.image_base64) ? j.data.image_base64.filter((u): u is string => typeof u === "string") : [];
    return answer(call, input, [...urls.map((url) => ({ url })), ...b64s.map((b64) => ({ b64 }))], "MiniMax");
  };
