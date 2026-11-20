/**
 * Anthropic Messages <-> OpenAI Chat Completions, for Claude-format clients (Claude Code) that call a model which is
 * not Anthropic's, or a combo (FR-TRN-02, FR-TRN-03, FR-TRN-07, FR-TRN-12). The request goes to the chat router as
 * chat; its answer, JSON or stream, comes back as a Claude message.
 *
 * Left out on the way in, because chat has no place for them: `cache_control`, thinking blocks of earlier turns
 * (their signatures only mean something to Anthropic), and server tools (typed tools such as `web_search_*`, which
 * only Anthropic runs).
 */
import { TranslateError } from "./openai-anthropic";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

/** `thinking.budget_tokens` as an OpenAI `reasoning_effort`. */
export function effortOf(budget: number): "low" | "medium" | "high" {
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

function imagePart(block: Json, where: string): Json {
  const s = isObj(block.source) ? block.source : {};
  if (s.type === "base64" && typeof s.media_type === "string" && typeof s.data === "string") return { type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } };
  if (s.type === "url" && typeof s.url === "string") return { type: "image_url", image_url: { url: s.url } };
  throw new TranslateError(`${where}: an image needs a base64 or url source`);
}

/** A PDF goes as a chat file part; a plain-text document as text. */
function documentPart(block: Json, where: string): Json {
  const s = isObj(block.source) ? block.source : {};
  if (s.type === "base64" && typeof s.media_type === "string" && typeof s.data === "string") {
    return { type: "file", file: { filename: str(block.title) || "document.pdf", file_data: `data:${s.media_type};base64,${s.data}` } };
  }
  if (s.type === "text" && typeof s.data === "string") return { type: "text", text: s.data };
  throw new TranslateError(`${where}: a document needs a base64 or text source`);
}

/** The text of a tool result; its images come back separately, for a user message after the tool messages. */
function toolResult(content: unknown, where: string): { text: string; images: Json[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (content === undefined || content === null) return { text: "", images: [] };
  if (!Array.isArray(content)) throw new TranslateError(`${where}: tool_result content must be a string or an array of blocks`);
  const texts: string[] = [];
  const images: Json[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === "text") texts.push(str(b.text));
    else if (b.type === "image") images.push(imagePart(b, where));
    else if (b.type === "document") texts.push(str(documentPart(b, where).text));
  }
  return { text: texts.join("\n"), images };
}

function blocksOf(content: unknown, where: string): Json[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new TranslateError(`${where}: content must be a string or an array of blocks`);
  return content.map((b, i) => {
    if (!isObj(b)) throw new TranslateError(`${where}.content[${i}] must be an object`);
    return b;
  });
}

/** One user turn: tool results first (chat wants them right after the assistant's tool calls), then the rest. */
function userMessages(content: unknown, where: string): Json[] {
  const tools: Json[] = [];
  const parts: Json[] = [];
  const toolImages: Json[] = [];
  for (const b of blocksOf(content, where)) {
    switch (b.type) {
      case "text":
        parts.push({ type: "text", text: str(b.text) });
        break;
      case "image":
        parts.push(imagePart(b, where));
        break;
      case "document":
        parts.push(documentPart(b, where));
        break;
      case "tool_result": {
        if (typeof b.tool_use_id !== "string") throw new TranslateError(`${where}: tool_result needs tool_use_id`);
        const r = toolResult(b.content, where);
        tools.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error === true ? `Error: ${r.text}` : r.text });
        toolImages.push(...r.images);
        break;
      }
      default:
        throw new TranslateError(`${where}: unsupported content block type ${String(b.type)}`);
    }
  }
  const out = [...tools];
  const all = [...toolImages, ...parts];
  if (all.length) out.push({ role: "user", content: all });
  return out;
}

function assistantMessage(content: unknown, where: string): Json | null {
  const texts: string[] = [];
  const calls: Json[] = [];
  for (const b of blocksOf(content, where)) {
    switch (b.type) {
      case "text":
        texts.push(str(b.text));
        break;
      case "tool_use":
        if (typeof b.id !== "string" || typeof b.name !== "string") throw new TranslateError(`${where}: tool_use needs id and name`);
        calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(isObj(b.input) ? b.input : {}) } });
        break;
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        throw new TranslateError(`${where}: unsupported content block type ${String(b.type)} (it works only with Anthropic models)`);
    }
  }
  const text = texts.join("");
  if (!text && !calls.length) return null;
  const m: Json = { role: "assistant", content: text || null };
  if (calls.length) m.tool_calls = calls;
  return m;
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (system === undefined || system === null) return "";
  if (!Array.isArray(system)) throw new TranslateError("system must be a string or an array of text blocks");
  return system
    .filter(isObj)
    .map((b) => {
      if (b.type !== "text") throw new TranslateError("system blocks must be text");
      return str(b.text);
    })
    .join("\n\n");
}

function toolChoice(choice: unknown): Json | string | undefined {
  if (!isObj(choice)) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      if (typeof choice.name !== "string") throw new TranslateError("tool_choice of type tool needs a name");
      return { type: "function", function: { name: choice.name } };
    default:
      throw new TranslateError(`unsupported tool_choice type ${String(choice.type)}`);
  }
}

/** An Anthropic Messages request as an OpenAI chat request. Throws TranslateError on what it cannot map. */
export function messagesToChat(req: Json): Json {
  if (typeof req.model !== "string" || req.model === "") throw new TranslateError("model is required");
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new TranslateError("messages must be a non-empty array");

  const messages: Json[] = [];
  const system = systemText(req.system);
  if (system) messages.push({ role: "system", content: system });
  for (const [i, m] of req.messages.entries()) {
    const where = `messages[${i}]`;
    if (!isObj(m)) throw new TranslateError(`${where} must be an object`);
    if (m.role === "user") messages.push(...userMessages(m.content, where));
    else if (m.role === "assistant") {
      const a = assistantMessage(m.content, where);
      if (a) messages.push(a);
    } else throw new TranslateError(`${where}: role must be user or assistant`);
  }

  const out: Json = { model: req.model, messages };
  if (typeof req.max_tokens === "number") out.max_tokens = req.max_tokens;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) out.stop = req.stop_sequences.filter((s) => typeof s === "string");
  if (req.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  const thinking = isObj(req.thinking) ? req.thinking : null;
  if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") out.reasoning_effort = effortOf(thinking.budget_tokens);

  // The client's own tools have no `type` (or `custom`); a typed one is a server tool only Anthropic runs.
  const tools = (Array.isArray(req.tools) ? req.tools : []).filter((t): t is Json => isObj(t) && (t.type === undefined || t.type === "custom"));
  if (tools.length) {
    out.tools = tools.map((t, i) => {
      if (typeof t.name !== "string") throw new TranslateError(`tools[${i}] needs a name`);
      return {
        type: "function",
        function: { name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), parameters: isObj(t.input_schema) ? t.input_schema : { type: "object", properties: {} } },
      };
    });
    const choice = toolChoice(req.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
    if (isObj(req.tool_choice) && req.tool_choice.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
  }
  return out;
}

// ---- Answers ---------------------------------------------------------------------------------------------------

const STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };
const stopReason = (finish: unknown, hadTools: boolean): string => (hadTools && (finish === "stop" || finish === undefined || finish === null) ? "tool_use" : STOP[str(finish)] ?? "end_turn");

/** Chat usage as Anthropic usage: input without the cached part, which has its own field. */
export function anthropicUsage(u: unknown): Json {
  const o = isObj(u) ? u : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cached = n(isObj(o.prompt_tokens_details) ? o.prompt_tokens_details.cached_tokens : 0);
  return { input_tokens: Math.max(0, n(o.prompt_tokens) - cached), output_tokens: n(o.completion_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

function parseInput(raw: unknown): Json {
  if (isObj(raw)) return raw;
  try {
    const v: unknown = JSON.parse(str(raw) || "{}");
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/** The reasoning text of a chat message or delta: `reasoning_content` (DeepSeek and others) or `reasoning`. */
const reasoningOf = (m: Json): string => str(m.reasoning_content) || str(m.reasoning);

/** A chat completion as a Claude message, named after the model the client asked for. */
export function chatToMessage(completion: Json, model: string): Json {
  const choice = Array.isArray(completion.choices) && isObj(completion.choices[0]) ? completion.choices[0] : {};
  const msg = isObj(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const reasoning = reasoningOf(msg);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (typeof msg.content === "string" && msg.content !== "") content.push({ type: "text", text: msg.content });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(isObj) : [];
  for (const tc of calls) {
    const fn = isObj(tc.function) ? tc.function : {};
    content.push({ type: "tool_use", id: str(tc.id) || rid("toolu"), name: str(fn.name), input: parseInput(fn.arguments) });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return { id: rid("msg"), type: "message", role: "assistant", model, content, stop_reason: stopReason(choice.finish_reason, calls.length > 0), stop_sequence: null, usage: anthropicUsage(completion.usage) };
}

/** The JSON `data:` payloads of a chat completions SSE stream; `[DONE]` comes through as the string. */
async function* chatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Json | "[DONE]"> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const parse = (raw: string): Json | "[DONE]" | null => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!l.startsWith("data:")) return null;
    const data = l.slice(5).trim();
    if (data === "[DONE]") return "[DONE]";
    try {
      const v: unknown = JSON.parse(data);
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
    if (!ended) await reader.cancel().catch(() => undefined);
  }
  const last = parse(buf);
  if (last) yield last;
}

const sseEvent = (enc: TextEncoder, data: Json) => enc.encode(`event: ${str(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * A chat completions stream as an Anthropic event stream. Blocks open as their first delta arrives and close when
 * another kind starts: thinking, text, then one block per tool call (by its chat `index`). A stream that ends
 * without a finish reason, or with an error chunk, ends with an `error` event.
 */
export function chatStreamToMessages(model: string, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const it = chatEvents(body)[Symbol.asyncIterator]();
  let started = false;
  let next = 0;
  let open: { index: number; kind: "thinking" | "text" | "tool"; key?: number | string } | null = null;
  let finish: unknown = null;
  let hadTools = false;
  let usage: unknown = null;

  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let sent = false;
      const send = (data: Json) => {
        ctrl.enqueue(sseEvent(enc, data));
        sent = true;
      };
      const close = () => {
        if (!open) return;
        send({ type: "content_block_stop", index: open.index });
        open = null;
      };
      const start = (kind: "thinking" | "text" | "tool", block: Json, key?: number | string) => {
        close();
        open = { index: next++, kind, key };
        send({ type: "content_block_start", index: open.index, content_block: block });
      };
      const fail = (message: string) => {
        close();
        send({ type: "error", error: { type: "api_error", message } });
        ctrl.close();
      };

      if (!started) {
        started = true;
        send({ type: "message_start", message: { id: rid("msg"), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        return;
      }
      while (!sent) {
        let r: IteratorResult<Json | "[DONE]">;
        try {
          r = await it.next();
        } catch {
          return fail("the stream from the provider broke off");
        }
        // [DONE] is not the end: reading on to the end of the body lets chat metering see the whole stream.
        if (!r.done && r.value === "[DONE]") continue;
        if (r.done || r.value === "[DONE]") {
          if (finish === null) return fail("the stream from the provider ended early");
          close();
          send({ type: "message_delta", delta: { stop_reason: stopReason(finish, hadTools), stop_sequence: null }, usage: anthropicUsage(usage) });
          send({ type: "message_stop" });
          ctrl.close();
          return;
        }
        const ev = r.value;
        if (isObj(ev.error)) {
          await it.return?.(undefined).catch(() => undefined);
          return fail(str(ev.error.message) || "the provider reported a failure");
        }
        if (isObj(ev.usage)) usage = ev.usage;
        const choice = Array.isArray(ev.choices) && isObj(ev.choices[0]) ? ev.choices[0] : null;
        if (!choice) continue;
        const delta = isObj(choice.delta) ? choice.delta : {};
        const reasoning = reasoningOf(delta);
        if (reasoning) {
          if (open?.kind !== "thinking") start("thinking", { type: "thinking", thinking: "", signature: "" });
          send({ type: "content_block_delta", index: open!.index, delta: { type: "thinking_delta", thinking: reasoning } });
        }
        if (typeof delta.content === "string" && delta.content !== "") {
          if (open?.kind !== "text") start("text", { type: "text", text: "" });
          send({ type: "content_block_delta", index: open!.index, delta: { type: "text_delta", text: delta.content } });
        }
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isObj(tc)) continue;
          // By chat `index`; else by id; a chunk with neither continues the open tool call.
          const key: number | string = typeof tc.index === "number" ? tc.index : str(tc.id) || (open?.kind === "tool" ? (open.key ?? -1) : -1);
          const fn = isObj(tc.function) ? tc.function : {};
          if (open?.kind !== "tool" || open.key !== key) {
            hadTools = true;
            start("tool", { type: "tool_use", id: str(tc.id) || rid("toolu"), name: str(fn.name), input: {} }, key);
          }
          const args = str(fn.arguments);
          if (args !== "") send({ type: "content_block_delta", index: open!.index, delta: { type: "input_json_delta", partial_json: args } });
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    },
    async cancel() {
      await it.return?.(undefined).catch(() => undefined);
    },
  });
}

/** A whole Claude message sent as Anthropic events, for a provider that answered JSON to a stream request. */
export function messageAsEvents(msg: Json): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const out: Uint8Array[] = [];
  const send = (data: Json) => out.push(sseEvent(enc, data));
  send({ type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  const blocks = Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: str(b.thinking) } });
    } else if (b.type === "tool_use") {
      send({ type: "content_block_start", index, content_block: { ...b, input: {} } });
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
    } else {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index, delta: { type: "text_delta", text: str(b.text) } });
    }
    send({ type: "content_block_stop", index });
  });
  send({ type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: msg.usage });
  send({ type: "message_stop" });
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const b of out) ctrl.enqueue(b);
      ctrl.close();
    },
  });
}

// ---- Errors and counting -----------------------------------------------------------------------------------------

/** The Anthropic error type for a status. */
export function anthropicErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

/** A chat-router error (OpenAI shape) as an Anthropic error with the same status and retry headers. */
export async function anthropicErrorFrom(res: Response): Promise<Response> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  const message = isObj(body?.error) && typeof body.error.message === "string" ? body.error.message : `error ${res.status}`;
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const h of ["retry-after", "x-should-retry", "x-gateway-target"]) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return new Response(JSON.stringify({ type: "error", error: { type: anthropicErrorType(res.status), message } }), { status: res.status, headers });
}

/** `count_tokens` for a model that is not Anthropic's (FR-API-05): about four characters per token. */
export function estimateTokens(req: Json): number {
  let chars = systemText(typeof req.system === "string" || Array.isArray(req.system) ? req.system : "").length;
  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!isObj(m)) continue;
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!isObj(b)) continue;
        if (b.type === "text") chars += str(b.text).length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input ?? {}).length;
        else if (b.type === "tool_result") chars += typeof b.content === "string" ? b.content.length : JSON.stringify(b.content ?? "").length;
      }
    }
  }
  if (Array.isArray(req.tools)) chars += JSON.stringify(req.tools).length;
  return Math.ceil(chars / 4);
}
