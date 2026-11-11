/**
 * OpenAI Chat Completions <-> Anthropic Messages, for clients that only speak the OpenAI format.
 * Idea from 9router's open-sse/translator (MIT, decolua and contributors); written anew for this gateway.
 */

type Json = Record<string, unknown>;

export class TranslateError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Default when the client sets no limit: Anthropic requires `max_tokens`. */
export const DEFAULT_MAX_TOKENS = 8192;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

type Block = Json;
type Msg = { role: "user" | "assistant"; content: Block[] };

function textOf(content: unknown, where: string): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (isObj(p) && p.type === "text" && typeof p.text === "string") return p.text;
        throw new TranslateError(`${where}: only text parts are supported here`);
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  throw new TranslateError(`${where}: content must be a string or an array of parts`);
}

function imageBlock(part: Json): Block {
  const url = isObj(part.image_url) ? part.image_url.url : part.image_url;
  if (typeof url !== "string") throw new TranslateError("image_url.url must be a string");
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  if (/^https:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
  throw new TranslateError("image_url.url must be an https URL or a base64 data URL");
}

function userBlocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new TranslateError("user content must be a string or an array of parts");
  return content.map((p) => {
    if (!isObj(p)) throw new TranslateError("content parts must be objects");
    if (p.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
    if (p.type === "image_url") return imageBlock(p);
    throw new TranslateError(`unsupported content part type: ${String(p.type)}`);
  });
}

function parseArgs(raw: unknown): Json {
  if (isObj(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (isObj(v)) return v;
  } catch {
    // fall through
  }
  throw new TranslateError("tool call arguments must be a JSON object");
}

/** Appends blocks to the last message when it has the same role (Anthropic wants turns to alternate). */
function push(out: Msg[], role: Msg["role"], blocks: Block[]): void {
  if (blocks.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else out.push({ role, content: blocks });
}

function toolChoice(choice: unknown, parallel: unknown): Json | undefined {
  let out: Json | undefined;
  if (choice === undefined || choice === "auto") out = { type: "auto" };
  else if (choice === "none") out = { type: "none" };
  else if (choice === "required") out = { type: "any" };
  else if (isObj(choice) && choice.type === "function" && isObj(choice.function) && typeof choice.function.name === "string") {
    out = { type: "tool", name: choice.function.name };
  } else throw new TranslateError("unsupported tool_choice");
  if (parallel === false && out.type !== "none") out.disable_parallel_tool_use = true;
  return out;
}

/** An OpenAI chat completion request as an Anthropic Messages request. Throws TranslateError on what it cannot map. */
export function chatToMessages(req: unknown): Json {
  if (!isObj(req)) throw new TranslateError("body must be a JSON object");
  if (typeof req.model !== "string" || req.model === "") throw new TranslateError("model is required");
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new TranslateError("messages must be a non-empty array");
  if (req.n !== undefined && req.n !== 1) throw new TranslateError("n other than 1 is not supported");

  const system: string[] = [];
  const messages: Msg[] = [];
  for (const [i, m] of req.messages.entries()) {
    if (!isObj(m)) throw new TranslateError(`messages[${i}] must be an object`);
    switch (m.role) {
      case "system":
      case "developer":
        system.push(textOf(m.content, `messages[${i}]`));
        break;
      case "user":
        push(messages, "user", userBlocks(m.content));
        break;
      case "assistant": {
        const blocks: Block[] = [];
        const text = textOf(m.content, `messages[${i}]`);
        if (text) blocks.push({ type: "text", text });
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (!isObj(tc) || !isObj(tc.function) || typeof tc.id !== "string" || typeof tc.function.name !== "string") {
              throw new TranslateError(`messages[${i}].tool_calls: each needs id and function.name`);
            }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
          }
        }
        push(messages, "assistant", blocks);
        break;
      }
      case "tool":
        if (typeof m.tool_call_id !== "string") throw new TranslateError(`messages[${i}]: tool messages need tool_call_id`);
        push(messages, "user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: textOf(m.content, `messages[${i}]`) }]);
        break;
      default:
        throw new TranslateError(`messages[${i}]: unsupported role ${String(m.role)}`);
    }
  }
  if (messages.length === 0) throw new TranslateError("messages need at least one user or assistant message");

  const out: Json = {
    model: req.model,
    messages,
    max_tokens: typeof req.max_completion_tokens === "number" ? req.max_completion_tokens : typeof req.max_tokens === "number" ? req.max_tokens : DEFAULT_MAX_TOKENS,
  };
  if (system.length) out.system = system.join("\n\n");
  if (typeof req.temperature === "number") out.temperature = Math.min(1, Math.max(0, req.temperature));
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (typeof req.stop === "string") out.stop_sequences = [req.stop];
  else if (Array.isArray(req.stop)) out.stop_sequences = req.stop.filter((s) => typeof s === "string");
  if (req.stream === true) out.stream = true;
  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools.map((t, i) => {
      if (!isObj(t) || t.type !== "function" || !isObj(t.function) || typeof t.function.name !== "string") {
        throw new TranslateError(`tools[${i}]: only function tools are supported`);
      }
      return {
        name: t.function.name,
        ...(typeof t.function.description === "string" ? { description: t.function.description } : {}),
        input_schema: isObj(t.function.parameters) ? t.function.parameters : { type: "object", properties: {} },
      };
    });
    out.tool_choice = toolChoice(req.tool_choice, req.parallel_tool_calls);
  }
  return out;
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

export const finishReason = (stop: unknown): string => (typeof stop === "string" && FINISH[stop]) || "stop";

export function openaiUsage(u: unknown): Json {
  const n = (k: string) => (isObj(u) && typeof u[k] === "number" ? (u[k] as number) : 0);
  const cached = n("cache_read_input_tokens");
  const prompt = n("input_tokens") + n("cache_creation_input_tokens") + cached;
  const completion = n("output_tokens");
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
}

/** A non-streaming Anthropic message as an OpenAI chat completion. */
export function messageToChat(msg: unknown, requestedModel: string, nowSec = Math.floor(Date.now() / 1000)): Json {
  const m = isObj(msg) ? msg : {};
  const blocks = Array.isArray(m.content) ? m.content.filter(isObj) : [];
  const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const message: Json = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: typeof m.id === "string" ? `chatcmpl-${m.id}` : `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: nowSec,
    model: typeof m.model === "string" ? m.model : requestedModel,
    choices: [{ index: 0, message, finish_reason: finishReason(m.stop_reason), logprobs: null }],
    usage: openaiUsage(m.usage),
  };
}

/** Maps an Anthropic error status/type to the OpenAI error envelope. */
export function openaiErrorBody(message: string, type: string, code: string | null = null): Json {
  return { error: { message, type, param: null, code } };
}

/**
 * Anthropic Messages SSE -> OpenAI chat.completion.chunk SSE, ending with `data: [DONE]`.
 * Tool calls are numbered among tool calls only (OpenAI `index`), not among all content blocks.
 */
export function streamToChat(requestedModel: string, includeUsage: boolean, nowSec = Math.floor(Date.now() / 1000)): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let id = `chatcmpl-${crypto.randomUUID()}`;
  let model = requestedModel;
  let usage: Json = {};
  let finish: string | null = null;
  const toolIndex = new Map<number, number>();
  let tools = 0;

  const chunk = (delta: Json, finishReason: string | null = null, extra: Json = {}) =>
    enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: nowSec, model, choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }], ...extra })}\n\n`);

  const handle = (ev: Json, ctrl: TransformStreamDefaultController<Uint8Array>) => {
    switch (ev.type) {
      case "message_start": {
        const m = isObj(ev.message) ? ev.message : {};
        if (typeof m.id === "string") id = `chatcmpl-${m.id}`;
        if (typeof m.model === "string") model = m.model;
        usage = { ...usage, ...(isObj(m.usage) ? m.usage : {}) };
        ctrl.enqueue(chunk({ role: "assistant", content: "" }));
        break;
      }
      case "content_block_start": {
        const b = isObj(ev.content_block) ? ev.content_block : {};
        if (b.type === "tool_use" && typeof ev.index === "number") {
          const ti = tools++;
          toolIndex.set(ev.index, ti);
          ctrl.enqueue(chunk({ tool_calls: [{ index: ti, id: b.id, type: "function", function: { name: b.name, arguments: "" } }] }));
        }
        break;
      }
      case "content_block_delta": {
        const d = isObj(ev.delta) ? ev.delta : {};
        if (d.type === "text_delta" && typeof d.text === "string") ctrl.enqueue(chunk({ content: d.text }));
        else if (d.type === "input_json_delta" && typeof d.partial_json === "string" && typeof ev.index === "number") {
          const ti = toolIndex.get(ev.index);
          if (ti !== undefined) ctrl.enqueue(chunk({ tool_calls: [{ index: ti, function: { arguments: d.partial_json } }] }));
        }
        break;
      }
      case "message_delta": {
        const d = isObj(ev.delta) ? ev.delta : {};
        if (d.stop_reason !== undefined) finish = finishReason(d.stop_reason);
        usage = { ...usage, ...(isObj(ev.usage) ? ev.usage : {}) };
        break;
      }
      case "message_stop":
        ctrl.enqueue(chunk({}, finish ?? "stop"));
        if (includeUsage) {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: nowSec, model, choices: [], usage: openaiUsage(usage) })}\n\n`));
        }
        ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
        break;
      case "error": {
        const e = isObj(ev.error) ? ev.error : {};
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(openaiErrorBody(typeof e.message === "string" ? e.message : "upstream error", typeof e.type === "string" ? e.type : "api_error"))}\n\n`));
        break;
      }
    }
  };

  const line = (raw: string, ctrl: TransformStreamDefaultController<Uint8Array>) => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!l.startsWith("data:")) return;
    try {
      const ev: unknown = JSON.parse(l.slice(5).trimStart());
      if (isObj(ev)) handle(ev, ctrl);
    } catch {
      // not JSON: ignore
    }
  };

  return new TransformStream({
    transform(bytes, ctrl) {
      buf += dec.decode(bytes, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i), ctrl);
        buf = buf.slice(i + 1);
      }
    },
    flush(ctrl) {
      buf += dec.decode();
      if (buf) line(buf, ctrl);
    },
  });
}
