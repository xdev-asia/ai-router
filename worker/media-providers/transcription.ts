/**
 * Speech to text: an OpenAI /v1/audio/transcriptions form (file, model, language, response_format) to each
 * provider's own API. The answer is `{text}` (json), the text alone (text) or `{text, language}` (verbose_json).
 * Subtitles (srt, vtt) are not offered: these providers do not answer timed segments in one shape.
 */
import { MediaError, badRequest, jsonResponse, poll, safePath, send, sendJson, upstreamError, type Call, type Result } from "./common";

export type TranscriptionAdapter = (form: FormData, call: Call) => Promise<Result>;

interface Input {
  file: File;
  language: string | null;
  format: "json" | "text" | "verbose_json";
}

function inputOf(form: FormData): Input {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw badRequest("file: the audio to transcribe");
  const lang = form.get("language");
  const language = typeof lang === "string" && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(lang.trim()) ? lang.trim() : null;
  const f = form.get("response_format");
  const format = f === null || f === "" || f === "json" ? "json" : f === "text" || f === "verbose_json" ? f : null;
  if (!format) throw badRequest("response_format: json, text or verbose_json (subtitles are not offered for this provider)");
  return { file, language, format };
}

function answer(input: Input, text: string, language: unknown): Result {
  if (input.format === "text") return { res: new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }) };
  if (input.format === "verbose_json") return { res: jsonResponse(typeof language === "string" && language ? { text, language } : { text }) };
  return { res: jsonResponse({ text }) };
}

const typeOf = (f: File) => f.type || "application/octet-stream";

export const deepgramTranscription: TranscriptionAdapter = async (form, call) => {
  const input = inputOf(form);
  const u = new URL("https://api.deepgram.com/v1/listen");
  u.searchParams.set("model", call.model);
  u.searchParams.set("smart_format", "true");
  u.searchParams.set("punctuate", "true");
  if (input.language) u.searchParams.set("language", input.language);
  else u.searchParams.set("detect_language", "true");
  const req = new Request(u.toString(), { method: "POST", headers: { authorization: `Token ${call.key}`, "content-type": typeOf(input.file) }, body: await input.file.arrayBuffer() });
  type DG = { results?: { channels?: { detected_language?: unknown; alternatives?: { transcript?: unknown }[] }[] } };
  const j = await sendJson<DG>(call, req, "Deepgram");
  const ch = j.results?.channels?.[0];
  const text = ch?.alternatives?.[0]?.transcript;
  if (typeof text !== "string") throw new MediaError(502, "Deepgram answered no transcript");
  return answer(input, text, ch?.detected_language ?? input.language);
};

const AAI = "https://api.assemblyai.com/v2";

export const assemblyaiTranscription: TranscriptionAdapter = async (form, call) => {
  const input = inputOf(form);
  const auth = { authorization: call.key };
  const up = await sendJson<{ upload_url?: unknown }>(
    call,
    new Request(`${AAI}/upload`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: await input.file.arrayBuffer() }),
    "AssemblyAI",
  );
  if (typeof up.upload_url !== "string") throw new MediaError(502, "AssemblyAI answered no upload URL");
  const body: Record<string, unknown> = { audio_url: up.upload_url, speech_models: [call.model] };
  if (input.language) body.language_code = input.language;
  else body.language_detection = true;
  const job = await sendJson<{ id?: unknown }>(
    call,
    new Request(`${AAI}/transcript`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }),
    "AssemblyAI",
  );
  if (typeof job.id !== "string" || !job.id) throw new MediaError(502, "AssemblyAI answered no transcript id");
  const url = `${AAI}/transcript/${encodeURIComponent(job.id)}`;
  const done = await poll<{ text: string; language: unknown }, { status?: unknown; text?: unknown; error?: unknown; language_code?: unknown }>(
    call,
    "AssemblyAI",
    () => new Request(url, { headers: auth }),
    (j) =>
      j.status === "completed"
        ? { done: { text: typeof j.text === "string" ? j.text : "", language: j.language_code } }
        : j.status === "error"
          ? { fail: typeof j.error === "string" ? j.error : "the transcript failed" }
          : null,
  );
  return answer(input, done.text, done.language);
};

export const elevenlabsTranscription: TranscriptionAdapter = async (form, call) => {
  const input = inputOf(form);
  const f = new FormData();
  f.set("file", input.file, input.file.name || "audio");
  f.set("model_id", call.model);
  if (input.language) f.set("language_code", input.language);
  const j = await sendJson<{ text?: unknown; language_code?: unknown }>(
    call,
    new Request("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": call.key }, body: f }),
    "ElevenLabs",
  );
  if (typeof j.text !== "string") throw new MediaError(502, "ElevenLabs answered no transcript");
  return answer(input, j.text, j.language_code);
};

export const huggingfaceTranscription: TranscriptionAdapter = async (form, call) => {
  const input = inputOf(form);
  const path = safePath(call.model);
  const res = await send(
    call,
    new Request(`https://router.huggingface.co/hf-inference/models/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${call.key}`, "content-type": typeOf(input.file) },
      body: await input.file.arrayBuffer(),
    }),
    "Hugging Face",
  );
  if (!res.ok) throw await upstreamError(res, call.key, "Hugging Face");
  const j = (await res.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof j?.text !== "string") throw new MediaError(502, "Hugging Face answered no transcript");
  return answer(input, j.text, null);
};
