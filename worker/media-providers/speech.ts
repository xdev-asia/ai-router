/**
 * Text to speech: an OpenAI /v1/audio/speech body ({model, input, voice, response_format, speed}) to each
 * provider's own API; the answer is the audio bytes. Providers whose voices are their own ids need `voice` set to
 * one of them: an OpenAI voice name ("alloy") counts as none.
 */
import { MediaError, audioResponse, b64ToBytes, badRequest, hexToBytes, send, sendJson, upstreamError, voiceOf, type Call, type Result } from "./common";
import { signV4 } from "./sigv4";

export type SpeechAdapter = (data: Record<string, unknown>, call: Call) => Promise<Result>;

const MP3 = "audio/mpeg";
const MAX_INPUT = 10_000;

function textOf(data: Record<string, unknown>): string {
  const t = data.input;
  if (typeof t !== "string" || !t.trim()) throw badRequest("input: the text to speak");
  if (t.length > MAX_INPUT) throw badRequest(`input: at most ${MAX_INPUT} characters`);
  return t;
}

function needVoice(data: Record<string, unknown>, provider: string): string {
  const v = voiceOf(data.voice);
  if (!v) throw badRequest(`voice: a ${provider} voice id (OpenAI voice names are not ${provider} voices)`);
  return v;
}

const speedOf = (data: Record<string, unknown>) => (typeof data.speed === "number" && data.speed >= 0.5 && data.speed <= 2 ? data.speed : null);

async function audio(call: Call, req: Request, provider: string, type = MP3): Promise<Result> {
  const res = await send(call, req, provider);
  if (!res.ok) throw await upstreamError(res, call.key, provider);
  return { res: audioResponse(res.body, type) };
}

const jsonReq = (url: string, headers: Record<string, string>, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

export const elevenlabsSpeech: SpeechAdapter = (data, call) => {
  const text = textOf(data);
  const voice = needVoice(data, "ElevenLabs");
  const pcm = data.response_format === "pcm";
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${pcm ? "pcm_24000" : "mp3_44100_128"}`;
  const speed = speedOf(data);
  const body: Record<string, unknown> = { text, model_id: call.model };
  if (speed !== null) body.voice_settings = { speed: Math.min(1.2, Math.max(0.7, speed)) };
  return audio(call, jsonReq(url, { "xi-api-key": call.key, accept: pcm ? "audio/pcm" : MP3 }, body), "ElevenLabs", pcm ? "audio/pcm" : MP3);
};

export const cartesiaSpeech: SpeechAdapter = (data, call) => {
  const transcript = textOf(data);
  const voice = needVoice(data, "Cartesia");
  const body = { model_id: call.model, transcript, voice: { mode: "id", id: voice }, output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 } };
  return audio(call, jsonReq("https://api.cartesia.ai/tts/bytes", { "x-api-key": call.key, "cartesia-version": "2024-06-10" }, body), "Cartesia");
};

export const fishSpeech: SpeechAdapter = (data, call) => {
  const text = textOf(data);
  const voice = voiceOf(data.voice);
  const body: Record<string, unknown> = { text, format: "mp3" };
  if (voice) body.reference_id = voice;
  return audio(call, jsonReq("https://api.fish.audio/v1/tts", { authorization: `Bearer ${call.key}`, model: call.model }, body), "Fish Audio");
};

export const playhtSpeech: SpeechAdapter = (data, call) => {
  const text = textOf(data);
  const voice = needVoice(data, "PlayHT");
  const i = call.key.indexOf(":");
  const userId = call.key.slice(0, i);
  const apiKey = call.key.slice(i + 1);
  const body = { text, voice, voice_engine: call.model, output_format: "mp3", speed: speedOf(data) ?? 1 };
  return audio(call, jsonReq("https://api.play.ht/api/v2/tts/stream", { "x-user-id": userId, authorization: `Bearer ${apiKey}`, accept: MP3 }, body), "PlayHT");
};

export const inworldSpeech: SpeechAdapter = async (data, call) => {
  const text = textOf(data);
  const body = { text, voiceId: voiceOf(data.voice) ?? "Alex", modelId: call.model, audioConfig: { audioEncoding: "MP3" } };
  const j = await sendJson<{ audioContent?: unknown }>(call, jsonReq("https://api.inworld.ai/tts/v1/voice", { authorization: `Basic ${call.key}` }, body), "Inworld");
  if (typeof j.audioContent !== "string") throw new MediaError(502, "Inworld answered no audio");
  return { res: audioResponse(b64ToBytes(j.audioContent), MP3) };
};

const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** `ACCESS_KEY_ID:SECRET_ACCESS_KEY[:REGION]` (us-east-1 when no region). */
export function awsKeyParts(key: string): { accessKeyId: string; secretAccessKey: string; region: string } | null {
  const [accessKeyId, secretAccessKey, region = "us-east-1", ...more] = key.split(":");
  if (more.length || !accessKeyId || !secretAccessKey || !/^[A-Z0-9]{16,128}$/.test(accessKeyId) || /\s/.test(secretAccessKey) || secretAccessKey.length < 16 || !AWS_REGION.test(region)) return null;
  return { accessKeyId, secretAccessKey, region };
}

export const pollySpeech: SpeechAdapter = async (data, call) => {
  const text = textOf(data);
  const parts = awsKeyParts(call.key);
  if (!parts) throw new MediaError(401, "the AWS key is not ACCESS_KEY_ID:SECRET_ACCESS_KEY[:REGION]");
  const url = `https://polly.${parts.region}.amazonaws.com/v1/speech`;
  const body = JSON.stringify({ Text: text, VoiceId: voiceOf(data.voice) ?? "Joanna", Engine: call.model, OutputFormat: "mp3" });
  const headers = { "content-type": "application/json" };
  const signed = await signV4({ method: "POST", url, headers, body, service: "polly", region: parts.region, accessKeyId: parts.accessKeyId, secretAccessKey: parts.secretAccessKey });
  return audio(call, new Request(url, { method: "POST", headers: { ...headers, ...signed }, body }), "Amazon Polly");
};

/** MiniMax answers 200 with its own status code; the ones that mean the account [Unverified: from MiniMax's error list]. */
export function minimaxError(base: unknown, provider: string): MediaError | null {
  const b = base && typeof base === "object" ? (base as { status_code?: unknown; status_msg?: unknown }) : {};
  const code = typeof b.status_code === "number" ? b.status_code : 0;
  if (code === 0) return null;
  const msg = typeof b.status_msg === "string" && b.status_msg ? b.status_msg : `${provider} error ${code}`;
  const status = code === 1004 ? 401 : code === 1002 || code === 1039 ? 429 : code === 1008 ? 402 : code === 2013 ? 400 : 502;
  return new MediaError(status, msg.slice(0, 300));
}

export const minimaxSpeech =
  (host: string): SpeechAdapter =>
  async (data, call) => {
    const text = textOf(data);
    const body = {
      model: call.model,
      text,
      stream: false,
      language_boost: "auto",
      output_format: "hex",
      voice_setting: { voice_id: voiceOf(data.voice) ?? "English_expressive_narrator", speed: speedOf(data) ?? 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    };
    const j = await sendJson<{ data?: { audio?: unknown }; base_resp?: unknown }>(call, jsonReq(`https://${host}/v1/t2a_v2`, { authorization: `Bearer ${call.key}` }, body), "MiniMax");
    const err = minimaxError(j.base_resp, "MiniMax");
    if (err) throw err;
    const hex = j.data?.audio;
    if (typeof hex !== "string" || !hex) throw new MediaError(502, "MiniMax answered no audio");
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(hex);
    } catch {
      throw new MediaError(502, "MiniMax answered audio that is not hex");
    }
    return { res: audioResponse(bytes, MP3) };
  };
