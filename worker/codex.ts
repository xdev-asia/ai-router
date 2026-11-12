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
export function chatToCodex(req: Json, model: string): Json {
  const input: Json[] = [];
  let instructions: string | null = null;
  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!isObj(m)) continue;
    if (m.role === "system" || m.role === "developer") {
      instructions ??= textOf(m.content);
    } else if (m.role === "user" || m.role === "assistant") {
      const content = parts(m.content, m.role === "user" ? "input_text" : "output_text");
      if (content.length > 0) input.push({ type: "message", role: m.role, content });
      for (const tc of m.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = isObj(tc) && isObj(tc.function) ? tc.function : null;
        const name = typeof fn?.name === "string" ? fn.name.trim() : "";
        if (!fn || !name) continue;
        input.push({ type: "function_call", call_id: String((tc as Json).id ?? ""), name, arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) });
      }
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: String(m.tool_call_id ?? ""), output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
    }
  }
  // The backend refuses an empty input.
  if (input.length === 0) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] });

  const effort = typeof req.reasoning_effort === "string" && EFFORTS.includes(req.reasoning_effort) ? req.reasoning_effort : "low";
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
      return [{ type: "function", name: (f.name as string).trim(), description: String(f.description ?? ""), parameters: f.parameters ?? { type: "object", properties: {} }, ...(f.strict === undefined ? {} : { strict: f.strict }) }];
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
  const last = parse(buf);
  if (last) yield last;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** What one event means for a chat completion. */
type Step =
  | { kind: "text"; delta: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "args"; delta: string }
  | { kind: "done"; usage: unknown; model: string | null }
  | { kind: "failed"; message: string }
  | null;

function step(ev: Json): Step {
  const item = isObj(ev.item) ? ev.item : null;
  const response = isObj(ev.response) ? ev.response : null;
  switch (ev.type) {
    case "response.output_text.delta":
      return typeof ev.delta === "string" ? { kind: "text", delta: ev.delta } : null;
    case "response.output_item.added":
      return item?.type === "function_call" ? { kind: "tool", call: { id: String(item.call_id ?? ""), name: String(item.name ?? ""), arguments: typeof item.arguments === "string" ? item.arguments : "" } } : null;
    case "response.function_call_arguments.delta":
      return typeof ev.delta === "string" ? { kind: "args", delta: ev.delta } : null;
    case "response.completed":
    case "response.done":
      return { kind: "done", usage: response?.usage, model: typeof response?.model === "string" ? response.model : null };
    case "response.failed":
    case "error": {
      const e = isObj(response?.error) ? response.error : isObj(ev.error) ? ev.error : ev;
      return { kind: "failed", message: typeof e.message === "string" ? e.message : "the provider reported a failure" };
    }
    default:
      return null;
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

export type CodexAnswer = { ok: true; completion: Json; usage: Usage } | { ok: false; message: string };

/** Reads the whole stream and returns one chat completion, or the failure the stream reported. */
export async function readCodex(body: ReadableStream<Uint8Array>, model: string): Promise<CodexAnswer> {
  let text = "";
  const calls: ToolCall[] = [];
  let usage: unknown;
  let reported: string | null = null;
  for await (const ev of codexEvents(body)) {
    const s = step(ev);
    if (!s) continue;
    if (s.kind === "text") text += s.delta;
    else if (s.kind === "tool") calls.push(s.call);
    else if (s.kind === "args") {
      const last = calls[calls.length - 1];
      if (last) last.arguments += s.delta;
    } else if (s.kind === "done") {
      usage = s.usage;
      reported = s.model;
    } else return { ok: false, message: s.message };
  }
  const answered = reported ?? model;
  const u = chatUsage(usage);
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
            content: text === "" && calls.length > 0 ? null : text,
            ...(calls.length > 0 ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}),
          },
          finish_reason: calls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: u,
    },
  };
}

/**
 * The stream as chat completion chunks. `usage` resolves when the stream ends, for metering. A failure the
 * stream reports is passed on as an `error` event, since the 200 status is already sent.
 */
export function codexToChatStream(body: ReadableStream<Uint8Array>, model: string, includeUsage: boolean): { client: ReadableStream<Uint8Array>; usage: Promise<Usage> } {
  let resolve!: (u: Usage) => void;
  const usage = new Promise<Usage>((r) => (resolve = r));
  const enc = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (ctrl: ReadableStreamDefaultController<Uint8Array>, data: unknown) => ctrl.enqueue(enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
  const client = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let first = true;
      let calls = 0;
      let found: Usage = { ...EMPTY, model };
      const chunk = (delta: Json, finish: string | null = null) => {
        send(ctrl, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: first && finish === null ? { role: "assistant", ...delta } : delta, finish_reason: finish }] });
        first = false;
      };
      try {
        for await (const ev of codexEvents(body)) {
          const s = step(ev);
          if (!s) continue;
          if (s.kind === "text") chunk({ content: s.delta });
          else if (s.kind === "tool") chunk({ tool_calls: [{ index: calls++, id: s.call.id, type: "function", function: { name: s.call.name, arguments: s.call.arguments } }] });
          else if (s.kind === "args") {
            if (calls > 0) chunk({ tool_calls: [{ index: calls - 1, function: { arguments: s.delta } }] });
          } else if (s.kind === "done") {
            const u = chatUsage(s.usage);
            found = usageOfOpenAI(s.model ?? model, u);
            chunk({}, calls > 0 ? "tool_calls" : "stop");
            if (includeUsage) send(ctrl, { id, object: "chat.completion.chunk", created, model, choices: [], usage: u });
          } else {
            send(ctrl, { error: { message: s.message, type: "api_error", param: null, code: null } });
            break;
          }
        }
      } catch {
        send(ctrl, { error: { message: "the stream from the provider broke off", type: "api_error", param: null, code: null } });
      }
      send(ctrl, "[DONE]");
      ctrl.close();
      resolve(found);
    },
  });
  return { client, usage };
}
