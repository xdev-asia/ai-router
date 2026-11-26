/**
 * The calls to xDev AI Router, through its OpenAI-compatible surface with this tool's gateway token. Models are
 * `<provider>/<model>` (or a combo name for chat), as the gateway's /v1/models lists them.
 */
export class AiRouterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AiRouterOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Between two looks at a video job. */
  pollMs?: number;
  /** How long a video job may take. */
  videoTimeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class AiRouter {
  private readonly f: typeof fetch;
  private token: string;

  constructor(private readonly o: AiRouterOptions) {
    this.f = o.fetch ?? fetch;
    this.token = o.token;
  }

  /** A new gateway token, from the settings ai-router's console sends (PUT /api/settings). */
  setToken(token: string): void {
    this.token = token;
  }

  get hasToken(): boolean {
    return !!this.token;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    let res: Response;
    try {
      res = await this.f(`${this.o.baseUrl}${path}`, { ...init, headers });
    } catch (e) {
      throw new AiRouterError(502, `could not reach ai-router: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new AiRouterError(res.status, `ai-router ${path}: ${await messageOf(res)}`);
    return res;
  }

  private json(path: string, body: unknown): Promise<Response> {
    return this.call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  /** The model ids this token may use. */
  async models(): Promise<string[]> {
    const j = (await (await this.call("/v1/models")).json()) as { data?: { id?: unknown }[] };
    return (j.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
  }

  async chat(model: string, messages: ChatMessage[], temperature = 0.8): Promise<string> {
    const j = (await (await this.json("/v1/chat/completions", { model, messages, temperature, stream: false })).json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new AiRouterError(502, "ai-router answered no text");
    return content;
  }

  /** One image's bytes. */
  async image(model: string, prompt: string, size: string): Promise<Buffer> {
    const j = (await (await this.json("/v1/images/generations", { model, prompt, size, n: 1, response_format: "b64_json" })).json()) as {
      data?: { b64_json?: unknown; url?: unknown }[];
    };
    const im = j.data?.[0];
    if (typeof im?.b64_json === "string") return Buffer.from(im.b64_json, "base64");
    if (typeof im?.url === "string") return this.download(im.url);
    throw new AiRouterError(502, "ai-router answered no image");
  }

  /** Spoken `input`, as MP3 bytes. */
  async speech(model: string, input: string, voice: string): Promise<Buffer> {
    const res = await this.json("/v1/audio/speech", { model, input, voice, response_format: "mp3" });
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * A video clip's bytes (experimental). The OpenAI videos API: POST /v1/videos makes a job, GET /v1/videos/{id}
   * says how it goes, GET /v1/videos/{id}/content is the MP4. A provider that answers the video at once
   * (`data[0].url` / `b64_json`, or `url`) needs no polling.
   */
  async video(model: string, prompt: string, seconds: number, size: string): Promise<Buffer> {
    const res = await this.json("/v1/videos", { model, prompt, seconds: String(seconds), size });
    if ((res.headers.get("content-type") ?? "").startsWith("video/")) return Buffer.from(await res.arrayBuffer());
    let job = (await res.json()) as VideoJob;
    const now = immediate(job);
    if (now) return now.b64 ? Buffer.from(now.b64, "base64") : this.download(now.url!);
    if (typeof job.id !== "string") throw new AiRouterError(502, "ai-router answered no video job");
    const id = encodeURIComponent(job.id);
    const until = Date.now() + (this.o.videoTimeoutMs ?? 15 * 60_000);
    while (job.status !== "completed") {
      if (job.status === "failed" || job.status === "cancelled") throw new AiRouterError(502, `video job ${job.status}: ${job.error?.message ?? "no reason given"}`);
      if (Date.now() > until) throw new AiRouterError(504, "video job took too long");
      await sleep(this.o.pollMs ?? 5000);
      job = (await (await this.call(`/v1/videos/${id}`)).json()) as VideoJob;
    }
    const done = immediate(job);
    if (done) return done.b64 ? Buffer.from(done.b64, "base64") : this.download(done.url!);
    return Buffer.from(await (await this.call(`/v1/videos/${id}/content`)).arrayBuffer());
  }

  /** A file a provider left at a URL: fetched without the gateway token. */
  private async download(url: string): Promise<Buffer> {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new AiRouterError(502, "not an http(s) URL");
    const res = await this.f(u);
    if (!res.ok) throw new AiRouterError(502, `could not download ${u.host} (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

interface VideoJob {
  id?: unknown;
  status?: string;
  error?: { message?: string };
  url?: unknown;
  data?: { url?: unknown; b64_json?: unknown }[];
}

function immediate(j: VideoJob): { url?: string; b64?: string } | null {
  const d = j.data?.[0];
  if (typeof d?.b64_json === "string") return { b64: d.b64_json };
  if (typeof d?.url === "string") return { url: d.url };
  if (typeof j.url === "string") return { url: j.url };
  return null;
}

async function messageOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string };
    const e = j.error;
    if (typeof e === "string") return e;
    if (typeof e?.message === "string") return e.message;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || `HTTP ${res.status}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
