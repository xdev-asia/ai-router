import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { pollTiming } from "../media-providers/common";
import { signV4 } from "../media-providers/sigv4";
import { ADMIN_TOKEN, addSystem, call, fakeUpstream, reset, usageRows, type FakeUpstream } from "./helpers";

// Every key below is a fake value made up for these tests.

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const bytes = (b: number[], type: string) => new Response(new Uint8Array(b), { headers: { "content-type": type } });
const post = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const upload = (token: string, fields: Record<string, string>): RequestInit => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "a.mp3", { type: "audio/mpeg" }));
  return { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form };
};
const admin = (method: string, path: string, body?: unknown) =>
  call(fakeUpstream(() => json({})), `/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function addKey(provider: string, apiKey: string, name = "main"): Promise<{ id: string }> {
  const r = await admin("POST", "/media/connections", { provider, name, api_key: apiKey });
  expect(r.res.status, r.text).toBe(201);
  return JSON.parse(r.text) as { id: string };
}
const sent = (up: FakeUpstream, i = 0) => JSON.parse(up.bodies[i]!) as Record<string, unknown>;
const b64 = (s: string) => btoa(s);

let token = "";
beforeEach(async () => {
  await reset();
  token = await addSystem("media");
  await env.DB.prepare("UPDATE system SET allowed_models = '[\"*\"]' WHERE id = 'media'").run();
  pollTiming.intervalMs = 0;
  pollTiming.maxPolls = 5;
});

describe("media provider accounts", () => {
  it("lists media providers per kind with their key state, and keeps them out of the chat providers", async () => {
    let r = await admin("GET", "/media");
    const before = JSON.parse(r.text) as { media_providers: { id: string; kinds: string[]; configured: boolean; models: Record<string, string[]> }[]; unsupported: { id: string }[] };
    const el = before.media_providers.find((p) => p.id === "elevenlabs")!;
    expect(el.kinds).toEqual(["speech", "transcription"]);
    expect(el.configured).toBe(false);
    expect(el.models.transcription).toContain("scribe_v1");
    expect(before.unsupported.map((p) => p.id)).toContain("local-device");
    // Only providers the media routes can call: OpenAI format with a fixed base URL.
    const listed = (JSON.parse(r.text) as { providers: string[] }).providers;
    expect(listed).toContain("openai");
    for (const id of ["azure", "cloudflare-ai", "vertex"]) expect(listed).not.toContain(id);

    await addKey("elevenlabs", "el-fake-key-0001-abcd");
    r = await admin("GET", "/media");
    expect(r.text).not.toContain("el-fake-key-0001");
    expect((JSON.parse(r.text) as typeof before).media_providers.find((p) => p.id === "elevenlabs")!.configured).toBe(true);

    const conns = await admin("GET", "/connections");
    expect(conns.text).not.toContain("el-fake-key-0001");
    expect(JSON.parse(conns.text)).toMatchObject([{ provider: "elevenlabs", hint: "abcd" }]);

    const chat = JSON.parse((await admin("GET", "/providers")).text) as { id: string }[];
    expect(chat.map((p) => p.id)).not.toContain("elevenlabs");
    expect((await admin("POST", "/combos", { name: "talk", targets: ["elevenlabs/eleven_multilingual_v2"] })).res.status).toBe(400);
  });

  it("refuses an unknown provider, an empty key and a key in the wrong form", async () => {
    expect((await admin("POST", "/media/connections", { provider: "nope", name: "a", api_key: "x-fake-key-123456" })).res.status).toBe(404);
    expect((await admin("POST", "/media/connections", { provider: "deepgram", name: "a", api_key: " " })).res.status).toBe(400);
    expect((await admin("POST", "/media/connections", { provider: "aws-polly", name: "a", api_key: "only-one-part" })).res.status).toBe(400);
    expect((await admin("POST", "/media/connections", { provider: "playht", name: "a", api_key: "no-user-id" })).res.status).toBe(400);
    expect((await admin("POST", "/media/connections", { provider: "google-tts", name: "a", api_key: "x-fake-key-123456" })).res.status).toBe(404);
  });
});

describe("speech", () => {
  it("ElevenLabs: voice in the path, xi-api-key, audio bytes back, a usage row", async () => {
    await addKey("elevenlabs", "el-fake-key-0001-abcd");
    const up = fakeUpstream(() => bytes([9, 8, 7], "audio/mpeg"));
    const { res } = await call(up, "/v1/audio/speech", post(token, { model: "elevenlabs/eleven_multilingual_v2", input: "Hello", voice: "voice-fake-1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(up.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-fake-1?output_format=mp3_44100_128");
    expect(up.calls[0]!.headers.get("xi-api-key")).toBe("el-fake-key-0001-abcd");
    expect(up.calls[0]!.headers.get("authorization")).toBeNull();
    expect(sent(up)).toMatchObject({ text: "Hello", model_id: "eleven_multilingual_v2" });
    const rows = await usageRows("media");
    expect(rows[0]).toMatchObject({ provider: "elevenlabs", model: "elevenlabs/eleven_multilingual_v2", status: 200 });
  });

  it("answers audio bytes for the request body as sent", async () => {
    await addKey("elevenlabs", "el-fake-key-0001-abcd");
    const up = fakeUpstream(() => bytes([9, 8, 7], "audio/mpeg"));
    const { res, text } = await call(up, "/v1/audio/speech", post(token, { model: "el/eleven_flash_v2_5", input: "Hi", voice: "v2", response_format: "pcm" }));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toContain("/text-to-speech/v2?output_format=pcm_24000");
    expect(res.headers.get("content-type")).toBe("audio/pcm");
  });

  it("refuses an OpenAI voice name for a provider that needs its own voice id, without calling it", async () => {
    await addKey("elevenlabs", "el-fake-key-0001-abcd");
    const up = fakeUpstream(() => bytes([1], "audio/mpeg"));
    const { res } = await call(up, "/v1/audio/speech", post(token, { model: "elevenlabs/eleven_multilingual_v2", input: "Hi", voice: "alloy" }));
    expect(res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it("tries the next account when a key is refused, and never echoes the key", async () => {
    await addKey("elevenlabs", "el-fake-key-0001-abcd", "first");
    await addKey("elevenlabs", "el-fake-key-0002-efgh", "second");
    const up = fakeUpstream((req) =>
      req.headers.get("xi-api-key") === "el-fake-key-0001-abcd" ? json({ detail: { message: "invalid key el-fake-key-0001-abcd" } }, 401) : bytes([5], "audio/mpeg"),
    );
    const { res } = await call(up, "/v1/audio/speech", post(token, { model: "elevenlabs/eleven_multilingual_v2", input: "Hi", voice: "v1" }));
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(2);
    const row = await env.DB.prepare("SELECT last_error FROM connection WHERE name = 'first'").first<{ last_error: string }>();
    expect(row!.last_error).toContain("invalid key");
    expect(row!.last_error).not.toContain("el-fake-key-0001");
  });

  it("keeps the key out of an error answer", async () => {
    await addKey("elevenlabs", "el-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({ detail: { message: "bad text for el-fake-key-0001-abcd" } }, 422));
    const { res, text } = await call(up, "/v1/audio/speech", post(token, { model: "elevenlabs/eleven_multilingual_v2", input: "Hi", voice: "v1" }));
    expect(res.status).toBe(422);
    expect(text).toContain("bad text");
    expect(text).not.toContain("el-fake-key-0001");
    expect(JSON.parse(text)).toMatchObject({ error: { type: "invalid_request_error" } });
  });

  it("Cartesia: X-API-Key, version header, voice by id", async () => {
    await addKey("cartesia", "ca-fake-key-0001-abcd");
    const up = fakeUpstream(() => bytes([1, 2], "audio/mpeg"));
    const { res } = await call(up, "/v1/audio/speech", post(token, { model: "cartesia/sonic-2", input: "Hi", voice: "voice-ca" }));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(up.calls[0]!.headers.get("x-api-key")).toBe("ca-fake-key-0001-abcd");
    expect(up.calls[0]!.headers.get("cartesia-version")).toBeTruthy();
    expect(sent(up)).toMatchObject({ model_id: "sonic-2", transcript: "Hi", voice: { mode: "id", id: "voice-ca" }, output_format: { container: "mp3" } });
  });

  it("Fish Audio: the model goes in a header; an OpenAI voice name means its default voice", async () => {
    await addKey("fish-audio", "fa-fake-key-0001-abcd");
    const up = fakeUpstream(() => bytes([1, 2], "audio/mpeg"));
    const { res } = await call(up, "/v1/audio/speech", post(token, { model: "fish/s1", input: "Hi", voice: "alloy" }));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.fish.audio/v1/tts");
    expect(up.calls[0]!.headers.get("model")).toBe("s1");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer fa-fake-key-0001-abcd");
    expect(sent(up)).toEqual({ text: "Hi", format: "mp3" });
  });

  it("Inworld: base64 audio in JSON comes back as bytes", async () => {
    await addKey("inworld", "iw-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({ audioContent: b64("ABC") }));
    const { res, text } = await call(up, "/v1/audio/speech", post(token, { model: "inworld/inworld-tts-1.5-mini", input: "Hi" }));
    expect(res.status).toBe(200);
    expect(text).toBe("ABC");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Basic iw-fake-key-0001-abcd");
    expect(sent(up)).toMatchObject({ text: "Hi", voiceId: "Alex", modelId: "inworld-tts-1.5-mini" });
  });

  it("PlayHT: the key is user id and secret", async () => {
    await addKey("playht", "user-fake:ph-fake-key-0001");
    const up = fakeUpstream(() => bytes([1], "audio/mpeg"));
    const { res } = await call(up, "/v1/audio/speech", post(token, { model: "playht/PlayDialog", input: "Hi", voice: "s3://voice-fake/manifest.json" }));
    expect(res.status).toBe(200);
    expect(up.calls[0]!.headers.get("x-user-id")).toBe("user-fake");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer ph-fake-key-0001");
    expect(sent(up)).toMatchObject({ text: "Hi", voice: "s3://voice-fake/manifest.json", voice_engine: "PlayDialog", output_format: "mp3" });
  });

  it("MiniMax: hex audio becomes bytes; minimax-cn goes to the China host; a status code is an error", async () => {
    await addKey("minimax", "mm-fake-key-0001-abcd");
    await addKey("minimax-cn", "mc-fake-key-0001-abcd");
    const up = fakeUpstream((req) =>
      req.url.includes("minimaxi.com") ? json({ base_resp: { status_code: 1004, status_msg: "login fail" } }) : json({ data: { audio: "414243" }, base_resp: { status_code: 0 } }),
    );
    const a = await call(up, "/v1/audio/speech", post(token, { model: "minimax/speech-2.8-hd", input: "Hi" }));
    expect(a.res.status).toBe(200);
    expect(a.text).toBe("ABC");
    expect(up.calls[0]!.url).toBe("https://api.minimax.io/v1/t2a_v2");
    expect(sent(up)).toMatchObject({ model: "speech-2.8-hd", text: "Hi", stream: false, voice_setting: { voice_id: "English_expressive_narrator" }, audio_setting: { format: "mp3" } });
    const b = await call(up, "/v1/audio/speech", post(token, { model: "minimax-cn/speech-2.8-hd", input: "Hi" }));
    expect(up.calls[1]!.url).toBe("https://api.minimaxi.com/v1/t2a_v2");
    expect(b.res.status).toBe(401);
    expect(b.text).toContain("login fail");
  });

  it("AWS Polly: signs the request with SigV4 and never sends the secret", async () => {
    await addKey("aws-polly", "AKIAFAKEFAKEFAKE0001:fake/secret/key/0001:eu-west-1");
    const up = fakeUpstream(() => bytes([1, 2, 3], "audio/mpeg"));
    const { res } = await call(up, "/v1/audio/speech", post(token, { model: "aws-polly/neural", input: "Hi", voice: "Amy" }));
    expect(res.status).toBe(200);
    const req = up.calls[0]!;
    expect(req.url).toBe("https://polly.eu-west-1.amazonaws.com/v1/speech");
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKEFAKEFAKE0001\/\d{8}\/eu-west-1\/polly\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(req.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect([...req.headers.values()].join(" ")).not.toContain("fake/secret");
    expect(sent(up)).toEqual({ Text: "Hi", VoiceId: "Amy", Engine: "neural", OutputFormat: "mp3" });
  });

  it("SigV4 matches AWS's documented example", async () => {
    // The example in AWS's SigV4 documentation (IAM ListUsers); its credentials are AWS's published example values.
    const h = await signV4({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      service: "iam",
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("transcription", () => {
  it("Deepgram: raw audio, Token auth, the transcript as {text}", async () => {
    await addKey("deepgram", "dg-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({ results: { channels: [{ alternatives: [{ transcript: "hello world" }] }] }, metadata: {} }));
    const { res, text } = await call(up, "/v1/audio/transcriptions", upload(token, { model: "deepgram/nova-3", language: "en" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ text: "hello world" });
    const u = new URL(up.calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(u.searchParams.get("model")).toBe("nova-3");
    expect(u.searchParams.get("language")).toBe("en");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Token dg-fake-key-0001-abcd");
    expect(up.calls[0]!.headers.get("content-type")).toBe("audio/mpeg");
    expect(up.bodies[0]!.length).toBe(4);
  });

  it("answers plain text for response_format text, and detects the language when none is given", async () => {
    await addKey("deepgram", "dg-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({ results: { channels: [{ alternatives: [{ transcript: "hi" }] }] } }));
    const { res, text } = await call(up, "/v1/audio/transcriptions", upload(token, { model: "dg/nova-2", response_format: "text" }));
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(text).toBe("hi");
    expect(new URL(up.calls[0]!.url).searchParams.get("detect_language")).toBe("true");
  });

  it("AssemblyAI: uploads, starts a transcript and waits for it", async () => {
    await addKey("assemblyai", "aa-fake-key-0001-abcd");
    let polls = 0;
    const up = fakeUpstream((req) => {
      if (req.url.endsWith("/v2/upload")) return json({ upload_url: "https://cdn.assemblyai.com/upload/fake" });
      if (req.url.endsWith("/v2/transcript")) return json({ id: "tr-1", status: "queued" });
      polls++;
      return json(polls < 2 ? { id: "tr-1", status: "processing" } : { id: "tr-1", status: "completed", text: "done talking", language_code: "en" });
    });
    const { res, text } = await call(up, "/v1/audio/transcriptions", upload(token, { model: "aai/universal-2" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ text: "done talking" });
    expect(up.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v2/upload", "/v2/transcript", "/v2/transcript/tr-1", "/v2/transcript/tr-1"]);
    expect(up.calls.every((c) => c.headers.get("authorization") === "aa-fake-key-0001-abcd")).toBe(true);
    expect(sent(up, 1)).toMatchObject({ audio_url: "https://cdn.assemblyai.com/upload/fake", speech_models: ["universal-2"], language_detection: true });
  });

  it("AssemblyAI: a failed transcript is an error, and a transcript that never ends times out", async () => {
    await addKey("assemblyai", "aa-fake-key-0001-abcd");
    const failing = fakeUpstream((req) =>
      req.url.endsWith("/v2/upload") ? json({ upload_url: "https://cdn.assemblyai.com/u" }) : req.url.endsWith("/v2/transcript") ? json({ id: "t" }) : json({ status: "error", error: "audio too short" }),
    );
    const a = await call(failing, "/v1/audio/transcriptions", upload(token, { model: "assemblyai/best" }));
    expect(a.res.status).toBe(502);
    expect(a.text).toContain("audio too short");
    const slow = fakeUpstream((req) =>
      req.url.endsWith("/v2/upload") ? json({ upload_url: "https://cdn.assemblyai.com/u" }) : req.url.endsWith("/v2/transcript") ? json({ id: "t" }) : json({ status: "processing" }),
    );
    const b = await call(slow, "/v1/audio/transcriptions", upload(token, { model: "assemblyai/best" }));
    expect(b.res.status).toBe(504);
    expect(slow.calls.length).toBe(2 + 5);
  });

  it("ElevenLabs: speech to text with multipart and model_id", async () => {
    await addKey("elevenlabs", "el-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({ text: "scribed", language_code: "en" }));
    const { res, text } = await call(up, "/v1/audio/transcriptions", upload(token, { model: "elevenlabs/scribe_v1", language: "en" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ text: "scribed" });
    expect(up.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(up.bodies[0]).toContain('name="model_id"');
    expect(up.bodies[0]).toContain("scribe_v1");
    expect(up.bodies[0]).toContain('name="language_code"');
  });

  it("Hugging Face: raw audio to the model, and a model path that climbs is refused", async () => {
    await addKey("huggingface", "hf_fakekey0001abcd");
    const up = fakeUpstream(() => json({ text: "hf heard" }));
    const ok = await call(up, "/v1/audio/transcriptions", upload(token, { model: "huggingface/openai/whisper-large-v3" }));
    expect(JSON.parse(ok.text)).toEqual({ text: "hf heard" });
    expect(up.calls[0]!.url).toBe("https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3");
    const bad = await call(up, "/v1/audio/transcriptions", upload(token, { model: "huggingface/openai/../x" }));
    expect(bad.res.status).toBe(400);
    expect(up.calls).toHaveLength(1);
  });
});

describe("images", () => {
  it("Black Forest Labs: submits, polls and answers the image URL", async () => {
    await addKey("black-forest-labs", "bfl-fake-key-0001");
    const up = fakeUpstream((req) =>
      req.method === "POST" ? json({ id: "job-1", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=job-1" }) : json({ status: "Ready", result: { sample: "https://delivery.bfl.ai/img.png" } }),
    );
    const { res, text } = await call(up, "/v1/images/generations", post(token, { model: "bfl/flux-pro-1.1", prompt: "a cat", size: "1024x768" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ data: [{ url: "https://delivery.bfl.ai/img.png" }] });
    expect(up.calls[0]!.url).toBe("https://api.bfl.ai/v1/flux-pro-1.1");
    expect(up.calls[0]!.headers.get("x-key")).toBe("bfl-fake-key-0001");
    expect(sent(up)).toMatchObject({ prompt: "a cat", width: 1024, height: 768 });
    expect(up.calls[1]!.url).toBe("https://api.eu.bfl.ai/v1/get_result?id=job-1");
  });

  it("fetches the image for b64_json, and never sends the key to a polling URL on another host", async () => {
    await addKey("black-forest-labs", "bfl-fake-key-0001");
    const up = fakeUpstream((req) =>
      req.method === "POST"
        ? json({ id: "job-1", polling_url: "https://api.bfl.ai/v1/get_result?id=job-1" })
        : req.url.startsWith("https://api.bfl.ai/")
          ? json({ status: "Ready", result: { sample: "https://delivery.bfl.ai/img.png" } })
          : bytes([65, 66, 67], "image/png"),
    );
    const a = await call(up, "/v1/images/generations", post(token, { model: "black-forest-labs/flux-dev", prompt: "x", response_format: "b64_json" }));
    expect(JSON.parse(a.text)).toMatchObject({ data: [{ b64_json: b64("ABC") }] });
    expect(up.calls[2]!.headers.get("x-key")).toBeNull();

    const evil = fakeUpstream((req) => (req.method === "POST" ? json({ id: "j", polling_url: "https://evil.test/steal" }) : json({})));
    const b = await call(evil, "/v1/images/generations", post(token, { model: "bfl/flux-dev", prompt: "x" }));
    expect(b.res.status).toBe(502);
    expect(evil.calls).toHaveLength(1);
  });

  it("fal: queues, polls the status and reads the result", async () => {
    await addKey("fal-ai", "fal-fake-key-0001");
    const up = fakeUpstream((req) => {
      if (req.method === "POST") return json({ request_id: "r1", status_url: "https://queue.fal.run/fal-ai/flux/requests/r1/status", response_url: "https://queue.fal.run/fal-ai/flux/requests/r1" });
      if (req.url.endsWith("/status")) return json({ status: "COMPLETED" });
      return json({ images: [{ url: "https://v3.fal.media/a.png" }, { url: "https://v3.fal.media/b.png" }] });
    });
    const { res, text } = await call(up, "/v1/images/generations", post(token, { model: "fal-ai/fal-ai/flux/schnell", prompt: "a dog", n: 2, size: "512x512" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ data: [{ url: "https://v3.fal.media/a.png" }, { url: "https://v3.fal.media/b.png" }] });
    expect(up.calls[0]!.url).toBe("https://queue.fal.run/fal-ai/flux/schnell");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Key fal-fake-key-0001");
    expect(sent(up)).toMatchObject({ prompt: "a dog", num_images: 2, image_size: { width: 512, height: 512 } });
  });

  it("Stability: multipart form, base64 image back", async () => {
    await addKey("stability-ai", "sk-fake-stability-0001");
    const up = fakeUpstream(() => json({ image: b64("PNG"), finish_reason: "SUCCESS" }));
    const { res, text } = await call(up, "/v1/images/generations", post(token, { model: "stability/sd3.5-large", prompt: "hills", size: "1792x1024" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ data: [{ b64_json: b64("PNG") }] });
    expect(up.calls[0]!.url).toBe("https://api.stability.ai/v2beta/stable-image/generate/sd3");
    expect(up.calls[0]!.headers.get("accept")).toBe("application/json");
    expect(up.calls[0]!.headers.get("content-type")).toContain("multipart/form-data");
    expect(up.bodies[0]).toContain("hills");
    expect(up.bodies[0]).toContain("16:9");
    expect(up.bodies[0]).toContain("sd3.5-large");
  });

  it("Recraft: OpenAI-shaped, sent as it came with its own model name", async () => {
    await addKey("recraft", "rc-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({ created: 1, data: [{ url: "https://img.recraft.ai/x.png" }] }));
    const { res, text } = await call(up, "/v1/images/generations", post(token, { model: "recraft/recraftv3", prompt: "logo", size: "1024x1024" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ data: [{ url: "https://img.recraft.ai/x.png" }] });
    expect(up.calls[0]!.url).toBe("https://external.api.recraft.ai/v1/images/generations");
    expect(sent(up)).toMatchObject({ model: "recraftv3", prompt: "logo", size: "1024x1024" });
  });

  it("Runway: a task, polled until it succeeds", async () => {
    await addKey("runwayml", "rw-fake-key-0001-abcd");
    const up = fakeUpstream((req) => (req.method === "POST" ? json({ id: "task-9" }) : json({ status: "SUCCEEDED", output: ["https://dnznrvs05pmza.cloudfront.net/x.png"] })));
    const { res, text } = await call(up, "/v1/images/generations", post(token, { model: "runwayml/gen4_image", prompt: "city", size: "1024x1024" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ data: [{ url: "https://dnznrvs05pmza.cloudfront.net/x.png" }] });
    expect(up.calls[0]!.url).toBe("https://api.dev.runwayml.com/v1/text_to_image");
    expect(up.calls[0]!.headers.get("x-runway-version")).toBe("2024-11-06");
    expect(sent(up)).toMatchObject({ promptText: "city", model: "gen4_image" });
    expect(up.calls[1]!.url).toBe("https://api.dev.runwayml.com/v1/tasks/task-9");
  });

  it("Hugging Face: image bytes come back as b64_json", async () => {
    await addKey("huggingface", "hf_fakekey0001abcd");
    const up = fakeUpstream(() => bytes([65, 66], "image/png"));
    const { res, text } = await call(up, "/v1/images/generations", post(token, { model: "huggingface/black-forest-labs/FLUX.1-schnell", prompt: "tree" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ data: [{ b64_json: b64("AB") }] });
    expect(up.calls[0]!.url).toBe("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell");
    expect(sent(up)).toEqual({ inputs: "tree" });
  });

  it("MiniMax: image_generation with an aspect ratio", async () => {
    await addKey("minimax", "mm-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({ data: { image_urls: ["https://minimax.test/i.png"] }, base_resp: { status_code: 0 } }));
    const { res, text } = await call(up, "/v1/images/generations", post(token, { model: "minimax/image-01", prompt: "sea", size: "1024x1792" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ data: [{ url: "https://minimax.test/i.png" }] });
    expect(up.calls[0]!.url).toBe("https://api.minimax.io/v1/image_generation");
    expect(sent(up)).toMatchObject({ model: "image-01", prompt: "sea", aspect_ratio: "9:16", response_format: "url", n: 1 });
  });
});

describe("embeddings", () => {
  it("Voyage: dimensions become output_dimension; the tokens are recorded", async () => {
    await addKey("voyage-ai", "pa-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({ object: "list", data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }], model: "voyage-3.5", usage: { total_tokens: 11 } }));
    const { res, text } = await call(up, "/v1/embeddings", post(token, { model: "voyage/voyage-3.5", input: ["a"], dimensions: 256, encoding_format: "float" }));
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ object: "list", data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 11, total_tokens: 11 } });
    expect(up.calls[0]!.url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(sent(up)).toEqual({ model: "voyage-3.5", input: ["a"], output_dimension: 256 });
    const rows = await usageRows("media");
    expect(rows[0]).toMatchObject({ provider: "voyage-ai", model: "voyage-ai/voyage-3.5", input_tokens: 11 });
  });

  it("Jina: OpenAI-shaped embeddings", async () => {
    await addKey("jina-ai", "jina_fake_key_0001");
    const up = fakeUpstream(() => json({ model: "jina-embeddings-v3", object: "list", data: [{ object: "embedding", index: 0, embedding: [1] }], usage: { total_tokens: 3, prompt_tokens: 3 } }));
    const { res, text } = await call(up, "/v1/embeddings", post(token, { model: "jina/jina-embeddings-v3", input: "hello", dimensions: 64 }));
    expect(res.status, text).toBe(200);
    expect(up.calls[0]!.url).toBe("https://api.jina.ai/v1/embeddings");
    expect(up.calls[0]!.headers.get("authorization")).toBe("Bearer jina_fake_key_0001");
    expect(sent(up)).toEqual({ model: "jina-embeddings-v3", input: ["hello"], dimensions: 64 });
    expect((await usageRows("media"))[0]).toMatchObject({ provider: "jina-ai", input_tokens: 3 });
  });
});

describe("media routing", () => {
  it("checks the system's allowed models, the kind the provider serves, and that it has a key", async () => {
    await addKey("voyage-ai", "pa-fake-key-0001-abcd");
    const up = fakeUpstream(() => json({}));
    expect((await call(up, "/v1/audio/speech", post(token, { model: "voyage-ai/voyage-3.5", input: "x" }))).res.status).toBe(400);
    const none = await call(up, "/v1/embeddings", post(token, { model: "jina-ai/jina-embeddings-v3", input: "x" }));
    expect(none.res.status).toBe(500);
    expect(none.text).toContain("not_configured");
    await env.DB.prepare("UPDATE system SET allowed_models = '[\"openai/*\"]' WHERE id = 'media'").run();
    expect((await call(up, "/v1/embeddings", post(token, { model: "voyage-ai/voyage-3.5", input: "x" }))).res.status).toBe(403);
    expect(up.calls).toHaveLength(0);
  });
});
