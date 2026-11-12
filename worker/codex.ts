import { usageOfOpenAI } from "./providers";
import { EMPTY, type Usage } from "./usage";
import { CODEX_DEFAULT_INSTRUCTIONS } from "./vendor/codexInstructions.js";

/**
 * Codex: a ChatGPT account reached the way the Codex CLI reaches it (the idea of 9router's Codex executor,
 * written anew). The backend speaks the OpenAI Responses API, always as a stream. This module turns a chat
 * completions request into that request, and the stream of `response.*` events back into a chat completion.
 */
export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CLI_VERSION = "0.167.1";
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The text of a message content: a string, or the text parts of an array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

function parts(content: unknown, type: "input_text" | "output_text"): Json[] {
  if (typeof content === "string") return content === "" ? [] : [{ type, text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((p): Json[] => {
    if (!isObj(p)) return [];
    if (p.type === "text" && typeof p.text === "string") return [{ type, text: p.text }];
    if (p.type === "image_url") {
      const image = p.image_url;
      const url = typeof image === "string" ? image : isObj(image) && typeof image.url === "string" ? image.url : null;
      return url ? [{ type: "input_image", image_url: url, detail: isObj(image) && typeof image.detail === "string" ? image.detail : "auto" }] : [];
    }
    return typeof p.text === "string" ? [{ type, text: p.text }] : [];
  });
}

/**
 * A chat completions request as a Codex Responses request. The first system (or developer) message becomes
 * `instructions`; without one the Codex CLI's own instructions are sent. Sampling settings and token limits are
 * left out: the backend refuses them.
 */

/**
 * A model name that ends with an effort, as 9router reads it: `gpt-5.2-codex-high` is `gpt-5.2-codex` with effort
 * high. `max` is sent as `xhigh`, except after a name ending in `codex`: `gpt-5.1-codex-max` is a model of its own.
 */
export function codexModel(name: string): { model: string; effort: string | null } {
  const m = /^(.+)-(none|minimal|low|medium|high|xhigh|max)$/.exec(name);
  if (!m) return { model: name, effort: null };
  const [, base, effort] = m as unknown as [string, string, string];
  if (effort === "max") return base.endsWith("codex") ? { model: name, effort: null } : { model: base, effort: "xhigh" };
  return { model: base, effort };
}

/** The backend refuses a call id longer than 64 characters, and an empty one. */
const callId = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s === "" ? `call_${crypto.randomUUID().replace(/-/g, "")}` : s.slice(0, 64);
};

/** An object schema needs `properties`, even an empty one. */
function schema(p: unknown): unknown {
  if (!isObj(p)) return { type: "object", properties: {} };
  return p.type === "object" && !isObj(p.properties) ? { ...p, properties: {} } : p;
}

/**
 * A chat completions request as a Codex Responses request. The first system (or developer) message becomes
 * `instructions`; without one the Codex CLI's own instructions are sent. Sampling settings and token limits are
 * left out: the backend refuses them.
 */
export function chatToCodex(req: Json, name: string): Json {
  const { model, effort: named } = codexModel(name);
  const input: Json[] = [];
  let instructions: string | null = null;
  // An assistant tool call and its tool answer must carry the same id; an empty id gets one generated once.
  const ids = new Map<string, string>();
  const idOf = (v: unknown) => {
    const raw = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
    if (raw.trim() === "") return callId(raw);
    let id = ids.get(raw);
    if (!id) ids.set(raw, (id = callId(raw)));
    return id;
  };
  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!isObj(m)) continue;
    if (m.role === "system" || m.role === "developer") {
      instructions ??= textOf(m.content);
    } else if (m.role === "user" || m.role === "assistant") {
      const content = parts(m.content, m.role === "user" ? "input_text" : "output_text");
      if (content.length > 0) input.push({ type: "message", role: m.role, content });
      for (const tc of m.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = isObj(tc) && isObj(tc.function) ? tc.function : null;
        const fname = typeof fn?.name === "string" ? fn.name.trim() : "";
        if (!fn || !fname) continue;
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        input.push({ type: "function_call", call_id: idOf((tc as Json).id), name: fname, arguments: args.trim() === "" ? "{}" : args });
      }
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: idOf(m.tool_call_id), output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
    }
  }
  // The backend refuses an empty input.
  if (input.length === 0) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] });

  const asked = typeof req.reasoning_effort === "string" && EFFORTS.includes(req.reasoning_effort) ? req.reasoning_effort : null;
  const effort = named ?? asked ?? "low";
  const body: Json = {
    model,
    instructions: instructions && instructions.trim() !== "" ? instructions : CODEX_DEFAULT_INSTRUCTIONS,
    input,
    stream: true,
    store: false,
    reasoning: { effort, summary: "auto" },
  };
  if (effort !== "none") body.include = ["reasoning.encrypted_content"];
  if (Array.isArray(req.tools)) {
    const tools = req.tools.flatMap((t): Json[] => {
      if (!isObj(t) || t.type !== "function" || !isObj(t.function) || typeof t.function.name !== "string") return [];
      const f = t.function;
      return [{ type: "function", name: (f.name as string).trim(), description: String(f.description ?? ""), parameters: schema(f.parameters), ...(f.strict === undefined ? {} : { strict: f.strict }) }];
    });
    if (tools.length > 0) body.tools = tools;
  }
  const choice = req.tool_choice;
  if (typeof choice === "string") body.tool_choice = choice;
  else if (isObj(choice) && isObj(choice.function) && typeof choice.function.name === "string") body.tool_choice = { type: "function", name: choice.function.name };
  return body;
}

/** The headers the Codex CLI sends. `account` is the ChatGPT account id from the login. */
export function codexHeaders(token: string, account: string | null): Headers {
  const h = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    originator: "codex_cli_rs",
    "user-agent": `codex_cli_rs/${CLI_VERSION}`,
    version: CLI_VERSION,
    session_id: crypto.randomUUID(),
  });
  if (account) h.set("chatgpt-account-id", account);
  return h;
}

/**
 * Where a Codex request goes. chatgpt.com refuses any request with the Cf-Worker header (a block page, 403), and
 * every request a Worker sends has it; so with CODEX_RELAY_URL set the request goes to the relay (`relay/`),
 * which sends it on from a plain server. The relay checks CODEX_RELAY_SECRET.
 */
export function codexDestination(env: { CODEX_RELAY_URL?: string; CODEX_RELAY_SECRET?: string }): { ok: true; url: string; secret: string | null } | { ok: false; message: string } {
  const relay = env.CODEX_RELAY_URL?.trim();
  if (!relay) return { ok: true, url: CODEX_URL, secret: null };
  const secret = env.CODEX_RELAY_SECRET?.trim();
  if (!secret) return { ok: false, message: "not_configured: CODEX_RELAY_URL is set but CODEX_RELAY_SECRET is not" };
  return { ok: true, url: relay.replace(/\/+$/, "") + "/codex/responses", secret };
}

export const RELAY_SECRET_HEADER = "x-relay-secret";
/** Set by the relay on its own refusals (403), so they are not read as chatgpt.com's. */
export const RELAY_ERROR_HEADER = "x-relay-error";

/** chatgpt.com's answer to a request from a Worker: a 403 HTML page, where its own refusals are JSON. */
export const isBlockPage = (res: Response): boolean => res.status === 403 && (res.headers.get("content-type") ?? "").startsWith("text/html");

export const BLOCKED_MESSAGE = "chatgpt.com refuses requests sent from a Cloudflare Worker: run the Codex relay and set CODEX_RELAY_URL and CODEX_RELAY_SECRET (README, Codex relay)";

/** The JSON events of a Responses SSE stream, in order. Lines that are not JSON are skipped. */
async function* codexEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const parse = (line: string): Json | null => {
    const l = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!l.startsWith("data:")) return null;
    try {
      const v: unknown = JSON.parse(l.slice(5).trimStart());
      return isObj(v) ? v : null;
    } catch {
      return null;
    }
  };
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const ev = parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (ev) yield ev;
      }
    }
    ended = true;
  } finally {
    // The reader stopped early (an answer complete, a failure, a client gone): the rest is not needed.
    if (!ended) await reader.cancel().catch(() => undefined);
  }
  const last = parse(buf);
  if (last) yield last;
}


interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** What one event means for a chat completion. `item`: the id of the output item a tool call is, when sent. */
export type Step =
  | { kind: "text"; delta: string }
  | { kind: "tool"; call: ToolCall; item: string | null }
  | { kind: "args"; delta: string; item: string | null }
  | { kind: "toolDone"; call: ToolCall; item: string | null }
  | { kind: "done"; usage: unknown; model: string | null; finish: "stop" | "length" }
  | { kind: "failed"; message: string };

export const ENDED_EARLY = "the stream from the provider ended early";

const toolCall = (item: Json): ToolCall => ({ id: callId(item.call_id), name: String(item.name ?? ""), arguments: typeof item.arguments === "string" ? item.arguments : "" });
const itemId = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

function step(ev: Json): Step | null {
  const item = isObj(ev.item) ? ev.item : null;
  const response = isObj(ev.response) ? ev.response : null;
  switch (ev.type) {
    case "response.output_text.delta":
      return typeof ev.delta === "string" ? { kind: "text", delta: ev.delta } : null;
    case "response.output_item.added":
      return item?.type === "function_call" ? { kind: "tool", call: toolCall(item), item: itemId(item.id) } : null;
    case "response.function_call_arguments.delta":
      return typeof ev.delta === "string" ? { kind: "args", delta: ev.delta, item: itemId(ev.item_id) } : null;
    case "response.output_item.done":
      return item?.type === "function_call" ? { kind: "toolDone", call: toolCall(item), item: itemId(item.id) } : null;
    case "response.completed":
    case "response.done":
    case "response.incomplete":
      return { kind: "done", usage: response?.usage, model: typeof response?.model === "string" ? response.model : null, finish: ev.type === "response.incomplete" ? "length" : "stop" };
    case "response.failed":
    case "error": {
      const e = isObj(response?.error) ? response.error : isObj(ev.error) ? ev.error : ev;
      return { kind: "failed", message: typeof e.message === "string" ? e.message : "the provider reported a failure" };
    }
    default:
      return null;
  }
}

/** The steps of a Responses stream, in order; events that mean nothing for a chat completion are left out. */
export async function* codexSteps(body: ReadableStream<Uint8Array>): AsyncGenerator<Step> {
  for await (const ev of codexEvents(body)) {
    const s = step(ev);
    if (s) yield s;
  }
}

/** The tool calls of one answer. Arguments go to the call of their item, or to the last call when no item is named. */
class Calls {
  readonly list: { call: ToolCall; item: string | null; streamed: boolean }[] = [];
  add(call: ToolCall, item: string | null): number {
    this.list.push({ call: { ...call }, item, streamed: call.arguments !== "" });
    return this.list.length - 1;
  }
  forArgs(item: string | null): number {
    const i = item === null ? -1 : this.list.findIndex((c) => c.item === item);
    return i >= 0 ? i : this.list.length - 1;
  }
  find(item: string | null, id: string): number {
    return this.list.findIndex((c) => (item !== null && c.item === item) || c.call.id === id);
  }
}

/** Usage of a Responses answer in OpenAI chat terms: cached tokens are part of the prompt tokens. */
function chatUsage(u: unknown): Json {
  const o = isObj(u) ? u : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const details = isObj(o.input_tokens_details) ? o.input_tokens_details : {};
  const prompt = num(o.input_tokens);
  const completion = num(o.output_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: num(details.cached_tokens) } };
}

const finishReason = (finish: "stop" | "length", calls: number) => (finish === "length" ? "length" : calls > 0 ? "tool_calls" : "stop");

export type CodexAnswer = { ok: true; completion: Json; usage: Usage } | { ok: false; message: string };

/**
 * Reads the whole stream and returns one chat completion, or the failure the stream reported. A stream that ends
 * before the provider says the answer is complete is a failure too, not a short answer.
 */
export async function readCodex(body: ReadableStream<Uint8Array>, model: string): Promise<CodexAnswer> {
  let text = "";
  const calls = new Calls();
  let done: Extract<Step, { kind: "done" }> | null = null;
  for await (const s of codexSteps(body)) {
    if (s.kind === "text") text += s.delta;
    else if (s.kind === "tool") calls.add(s.call, s.item);
    else if (s.kind === "args") {
      const c = calls.list[calls.forArgs(s.item)];
      if (c) c.call.arguments += s.delta;
    } else if (s.kind === "toolDone") {
      const c = calls.list[calls.find(s.item, s.call.id)];
      if (!c) calls.add(s.call, s.item);
      else if (c.call.arguments === "") c.call.arguments = s.call.arguments;
    } else if (s.kind === "done") {
      done = s;
      break;
    } else return { ok: false, message: s.message };
  }
  if (!done) return { ok: false, message: ENDED_EARLY };
  const answered = done.model ?? model;
  const u = chatUsage(done.usage);
  const list = calls.list.map((c) => c.call);
  return {
    ok: true,
    usage: usageOfOpenAI(answered, u),
    completion: {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: answered,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text === "" && list.length > 0 ? null : text,
            ...(list.length > 0 ? { tool_calls: list.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments === "" ? "{}" : c.arguments } })) } : {}),
          },
          finish_reason: finishReason(done.finish, list.length),
        },
      ],
      usage: u,
    },
  };
}

/**
 * The stream as chat completion chunks: `first` is the step the caller already read (to answer an early failure
 * with a status), `rest` the steps after it. `usage` resolves when the stream ends, for metering. A failure the
 * stream reports, or its end before the answer is complete, is passed on as an `error` event, since the 200
 * status is already sent. Steps are read only as the client reads.
 */
export function codexToChatStream(first: Step, rest: AsyncIterator<Step>, model: string, includeUsage: boolean): { client: ReadableStream<Uint8Array>; usage: Promise<Usage> } {
  let resolve!: (u: Usage) => void;
  const usage = new Promise<Usage>((r) => (resolve = r));
  const enc = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const calls = new Calls();
  let pending: Step | null = first;
  let started = false;
  let found: Usage = { ...EMPTY, model };

  const client = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const send = (data: unknown) => ctrl.enqueue(enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
      const chunk = (delta: Json, finish: string | null = null) => {
        send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: !started && finish === null ? { role: "assistant", ...delta } : delta, finish_reason: finish }] });
        started = true;
      };
      const end = (error: string | null) => {
        if (error !== null) send({ error: { message: error, type: "api_error", param: null, code: null } });
        send("[DONE]");
        ctrl.close();
        resolve(found);
      };
      // Loops until something is sent, so each pull answers with a chunk or the end.
      for (;;) {
        let s: Step;
        if (pending) {
          s = pending;
          pending = null;
        } else {
          let r: IteratorResult<Step>;
          try {
            r = await rest.next();
          } catch {
            return end("the stream from the provider broke off");
          }
          if (r.done) return end(ENDED_EARLY);
          s = r.value;
        }
        if (s.kind === "text") {
          if (s.delta === "") continue;
          return chunk({ content: s.delta });
        }
        if (s.kind === "tool") {
          const i = calls.add(s.call, s.item);
          return chunk({ tool_calls: [{ index: i, id: s.call.id, type: "function", function: { name: s.call.name, arguments: s.call.arguments } }] });
        }
        if (s.kind === "args") {
          const i = calls.forArgs(s.item);
          if (i < 0 || s.delta === "") continue;
          calls.list[i]!.streamed = true;
          return chunk({ tool_calls: [{ index: i, function: { arguments: s.delta } }] });
        }
        if (s.kind === "toolDone") {
          const i = calls.find(s.item, s.call.id);
          if (i < 0) {
            const n = calls.add(s.call, s.item);
            return chunk({ tool_calls: [{ index: n, id: s.call.id, type: "function", function: { name: s.call.name, arguments: s.call.arguments === "" ? "{}" : s.call.arguments } }] });
          }
          const c = calls.list[i]!;
          if (c.streamed || s.call.arguments === "") continue;
          c.streamed = true;
          return chunk({ tool_calls: [{ index: i, function: { arguments: s.call.arguments } }] });
        }
        if (s.kind === "done") {
          const u = chatUsage(s.usage);
          found = usageOfOpenAI(s.model ?? model, u);
          chunk({}, finishReason(s.finish, calls.list.length));
          if (includeUsage) send({ id, object: "chat.completion.chunk", created, model, choices: [], usage: u });
          await rest.return?.(undefined).catch(() => undefined);
          return end(null);
        }
        await rest.return?.(undefined).catch(() => undefined);
        return end(s.message);
      }
    },
    async cancel() {
      resolve(found);
      await rest.return?.(undefined).catch(() => undefined);
    },
  });
  return { client, usage };
}
