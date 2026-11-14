/**
 * The OpenAI Responses API (`POST /v1/responses`) on top of chat routing: the request is turned into a chat
 * completions request, sent through `runChat` (models, combos, savers, metering as for chat), and the chat
 * answer or stream is turned back into a Responses object or `response.*` events. Codex CLI reaches custom
 * providers only this way (`wire_api = "responses"`). Nothing is stored: `previous_response_id` is refused,
 * the client sends the whole conversation (Codex does, with `store: false`).
 */
import type { Context } from "hono";
import type { System } from "./auth";
import type { AppEnv } from "./env";
import type { Upstream } from "./proxy";
import { errorResponse, runChat } from "./route";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

export class ResponsesError extends Error {}

/** The text of Responses content: a string, or its text parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (isObj(p) && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** User content as chat content: a plain string when it is text only, else chat parts. */
function userContent(content: unknown): string | Json[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: Json[] = [];
  for (const p of content) {
    if (!isObj(p)) continue;
    if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") out.push({ type: "text", text: p.text });
    else if (p.type === "input_image") {
      const url = typeof p.image_url === "string" ? p.image_url : isObj(p.image_url) && typeof p.image_url.url === "string" ? p.image_url.url : "";
      if (url) out.push({ type: "image_url", image_url: { url, detail: typeof p.detail === "string" ? p.detail : "auto" } });
    } else if (p.type === "input_file" && typeof p.file_data === "string") {
      out.push({ type: "file", file: { file_data: p.file_data, ...(typeof p.filename === "string" ? { filename: p.filename } : {}) } });
    }
  }
  return out.every((p) => p.type === "text") ? out.map((p) => p.text as string).join("\n") : out;
}

/** A Responses request as a chat completions request. Throws ResponsesError on what cannot be sent. */
export function responsesToChat(req: Json): Json {
  if (typeof req.model !== "string" || req.model.trim() === "") throw new ResponsesError("model is required");
  if (req.previous_response_id !== undefined && req.previous_response_id !== null)
    throw new ResponsesError("previous_response_id is not supported: this gateway stores no responses, send the whole conversation in input");
  if (req.input === undefined || req.input === null) throw new ResponsesError("input is required");

  const system: string[] = [];
  if (typeof req.instructions === "string" && req.instructions.trim() !== "") system.push(req.instructions);
  const messages: Json[] = [];
  // Consecutive function_call items belong to one assistant message.
  let assistant: Json | null = null;
  const flush = () => {
    if (assistant) messages.push(assistant);
    assistant = null;
  };

  const items = typeof req.input === "string" ? [{ role: "user", content: req.input }] : Array.isArray(req.input) ? req.input : null;
  if (!items) throw new ResponsesError("input must be a string or an array of items");
  for (const it of items) {
    if (!isObj(it)) continue;
    const type = it.type ?? "message";
    if (type === "message") {
      const role = str(it.role);
      if (role === "system" || role === "developer") {
        const t = textOf(it.content);
        if (t) {
          if (messages.length === 0 && !assistant) system.push(t);
          else {
            flush();
            messages.push({ role: "system", content: t });
          }
        }
      } else if (role === "assistant") {
        flush();
        assistant = { role: "assistant", content: textOf(it.content) };
      } else if (role === "user") {
        flush();
        messages.push({ role: "user", content: userContent(it.content) });
      }
    } else if (type === "function_call") {
      const call = { id: str(it.call_id) || str(it.id) || rid("call"), type: "function", function: { name: str(it.name), arguments: str(it.arguments) || "{}" } };
      if (!assistant) assistant = { role: "assistant", content: null };
      const a = assistant as Json;
      a.tool_calls = [...(Array.isArray(a.tool_calls) ? a.tool_calls : []), call];
    } else if (type === "function_call_output") {
      flush();
      const output = typeof it.output === "string" ? it.output : Array.isArray(it.output) ? textOf(it.output) : JSON.stringify(it.output ?? "");
      messages.push({ role: "tool", tool_call_id: str(it.call_id), content: output });
    }
    // reasoning and other item types carry nothing a chat model can read.
  }
  flush();
  if (system.length > 0) messages.unshift({ role: "system", content: system.join("\n\n") });
  if (!messages.some((m) => m.role !== "system")) throw new ResponsesError("input has no message");

  const chat: Json = { model: req.model, messages };
  if (Array.isArray(req.tools)) {
    const tools = req.tools.flatMap((t): Json[] => {
      if (!isObj(t) || t.type !== "function" || typeof t.name !== "string") return [];
      const fn: Json = { name: t.name };
      if (typeof t.description === "string") fn.description = t.description;
      fn.parameters = isObj(t.parameters) ? t.parameters : { type: "object", properties: {} };
      if (typeof t.strict === "boolean") fn.strict = t.strict;
      return [{ type: "function", function: fn }];
    });
    if (tools.length > 0) chat.tools = tools;
  }
  const choice = req.tool_choice;
  if (chat.tools) {
    if (choice === "auto" || choice === "none" || choice === "required") chat.tool_choice = choice;
    else if (isObj(choice) && choice.type === "function" && typeof choice.name === "string") chat.tool_choice = { type: "function", function: { name: choice.name } };
    if (typeof req.parallel_tool_calls === "boolean") chat.parallel_tool_calls = req.parallel_tool_calls;
  }
  if (typeof req.max_output_tokens === "number") chat.max_tokens = req.max_output_tokens;
  for (const k of ["temperature", "top_p", "user", "metadata", "service_tier"] as const) if (req[k] !== undefined && req[k] !== null) chat[k] = req[k];
  if (isObj(req.reasoning) && typeof req.reasoning.effort === "string") chat.reasoning_effort = req.reasoning.effort;
  const format = isObj(req.text) && isObj(req.text.format) ? req.text.format : null;
  if (format?.type === "json_schema") {
    chat.response_format = { type: "json_schema", json_schema: { name: str(format.name) || "output", schema: format.schema, ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}) } };
  } else if (format?.type === "json_object") chat.response_format = { type: "json_object" };
  if (req.stream === true) {
    chat.stream = true;
    chat.stream_options = { include_usage: true };
  }
  return chat;
}

/** Chat usage in Responses terms. */
function usageOf(u: unknown): Json | null {
  if (!isObj(u)) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const pd = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const cd = isObj(u.completion_tokens_details) ? u.completion_tokens_details : {};
  const input = n(u.prompt_tokens);
  const output = n(u.completion_tokens);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: n(pd.cached_tokens) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: n(cd.reasoning_tokens) },
    total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : input + output,
  };
}

/** The fields of a response object that echo the request. */
function base(req: Json, id: string, created: number, model: string): Json {
  return {
    id,
    object: "response",
    created_at: created,
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: typeof req.instructions === "string" ? req.instructions : null,
    max_output_tokens: typeof req.max_output_tokens === "number" ? req.max_output_tokens : null,
    model,
    output: [] as Json[],
    parallel_tool_calls: req.parallel_tool_calls !== false,
    previous_response_id: null,
    reasoning: isObj(req.reasoning) ? req.reasoning : null,
    store: false,
    temperature: typeof req.temperature === "number" ? req.temperature : null,
    text: isObj(req.text) ? req.text : { format: { type: "text" } },
    tool_choice: req.tool_choice ?? "auto",
    tools: Array.isArray(req.tools) ? req.tools : [],
    top_p: typeof req.top_p === "number" ? req.top_p : null,
    usage: null,
  };
}

const messageItem = (id: string, text: string, status: string): Json => ({
  type: "message",
  id,
  status,
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});

/** The text the SDKs expose as `output_text`. */
const outputText = (output: Json[]) =>
  output
    .filter((o) => o.type === "message")
    .flatMap((o) => (o.content as Json[]).map((p) => str(p.text)))
    .join("");

function finish(resp: Json, reason: unknown): void {
  if (reason === "length") {
    resp.status = "incomplete";
    resp.incomplete_details = { reason: "max_output_tokens" };
  } else if (reason === "content_filter") {
    resp.status = "incomplete";
    resp.incomplete_details = { reason: "content_filter" };
  } else resp.status = "completed";
}

/** A chat completion as a Responses object. */
export function chatToResponse(req: Json, completion: Json): Json {
  const choice = Array.isArray(completion.choices) && isObj(completion.choices[0]) ? completion.choices[0] : {};
  const msg = isObj(choice.message) ? choice.message : {};
  const resp = base(req, rid("resp"), typeof completion.created === "number" ? completion.created : Math.floor(Date.now() / 1000), str(completion.model) || str(req.model));
  const output: Json[] = [];
  const reasoning = str(msg.reasoning_content) || str(msg.reasoning);
  if (reasoning) output.push({ type: "reasoning", id: rid("rs"), summary: [{ type: "summary_text", text: reasoning }] });
  const text = textOf(msg.content);
  if (text) output.push(messageItem(rid("msg"), text, "completed"));
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    if (!isObj(tc) || !isObj(tc.function)) continue;
    output.push({ type: "function_call", id: rid("fc"), call_id: str(tc.id) || rid("call"), name: str(tc.function.name), arguments: str(tc.function.arguments) || "{}", status: "completed" });
  }
  resp.output = output;
  resp.output_text = outputText(output);
  resp.usage = usageOf(completion.usage);
  finish(resp, choice.finish_reason);
  return resp;
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

interface Open {
  index: number;
  item: Json;
  kind: "message" | "tool";
  text: string;
}

/**
 * A chat completions stream as a Responses event stream. Items are opened as their first delta arrives; a text
 * item closes when a tool call starts, every item closes at the end. A stream that ends without a finish reason,
 * or with an error chunk, ends with `response.failed`.
 */
export function chatStreamToResponses(req: Json, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const resp = base(req, rid("resp"), Math.floor(Date.now() / 1000), str(req.model));
  const output: Json[] = [];
  const it = chatEvents(body)[Symbol.asyncIterator]();
  let seq = 0;
  let text: Open | null = null;
  const tools = new Map<number, Open>();
  let finishReason: unknown = null;
  let started = false;

  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const send = (type: string, data: Json) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`));
      const snapshot = () => ({ ...resp, output: [...output] });
      const closeText = () => {
        if (!text) return;
        const t = text;
        text = null;
        const part = { type: "output_text", text: t.text, annotations: [] };
        send("response.output_text.done", { item_id: t.item.id, output_index: t.index, content_index: 0, text: t.text });
        send("response.content_part.done", { item_id: t.item.id, output_index: t.index, content_index: 0, part });
        const done = messageItem(t.item.id as string, t.text, "completed");
        output[t.index] = done;
        send("response.output_item.done", { output_index: t.index, item: done });
      };
      const closeTools = () => {
        for (const t of [...tools.values()].sort((a, b) => a.index - b.index)) {
          const args = t.text === "" ? "{}" : t.text;
          send("response.function_call_arguments.done", { item_id: t.item.id, output_index: t.index, arguments: args });
          const done = { ...t.item, arguments: args, status: "completed" };
          output[t.index] = done;
          send("response.output_item.done", { output_index: t.index, item: done });
        }
        tools.clear();
      };
      const fail = (message: string) => {
        closeText();
        closeTools();
        resp.status = "failed";
        resp.error = { code: "server_error", message };
        send("response.failed", { response: snapshot() });
        ctrl.close();
      };

      if (!started) {
        started = true;
        send("response.created", { response: snapshot() });
        send("response.in_progress", { response: snapshot() });
        return;
      }
      // Reads until something was sent, so each pull answers with events or the end.
      const before = seq;
      while (seq === before) {
        let r: IteratorResult<Json | "[DONE]">;
        try {
          r = await it.next();
        } catch {
          return fail("the stream from the provider broke off");
        }
        // [DONE] is not the end: reading on to the end of the body lets chat metering see the whole stream.
        if (!r.done && r.value === "[DONE]") continue;
        if (r.done || r.value === "[DONE]") {
          if (finishReason === null) return fail("the stream from the provider ended early");
          closeText();
          closeTools();
          resp.output = output;
          resp.output_text = outputText(output);
          finish(resp, finishReason);
          send(resp.status === "incomplete" ? "response.incomplete" : "response.completed", { response: { ...resp, output: [...output] } });
          ctrl.close();
          return;
        }
        const ev = r.value;
        if (isObj(ev.error)) {
          await it.return?.(undefined).catch(() => undefined);
          return fail(str(ev.error.message) || "the provider reported a failure");
        }
        if (typeof ev.model === "string" && ev.model !== "") resp.model = ev.model;
        const u = usageOf(ev.usage);
        if (u) resp.usage = u;
        const choice = Array.isArray(ev.choices) && isObj(ev.choices[0]) ? ev.choices[0] : null;
        if (!choice) continue;
        const delta = isObj(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string" && delta.content !== "") {
          if (!text) {
            const item = { type: "message", id: rid("msg"), status: "in_progress", role: "assistant", content: [] };
            text = { index: output.length, item, kind: "message", text: "" };
            output.push(item);
            send("response.output_item.added", { output_index: text.index, item });
            send("response.content_part.added", { item_id: item.id, output_index: text.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          }
          text.text += delta.content;
          send("response.output_text.delta", { item_id: text.item.id, output_index: text.index, content_index: 0, delta: delta.content });
        }
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isObj(tc)) continue;
          const key = typeof tc.index === "number" ? tc.index : tools.size;
          const fn = isObj(tc.function) ? tc.function : {};
          let open = tools.get(key);
          if (!open) {
            closeText();
            const item = { type: "function_call", id: rid("fc"), call_id: str(tc.id) || rid("call"), name: str(fn.name), arguments: "", status: "in_progress" };
            open = { index: output.length, item, kind: "tool", text: "" };
            tools.set(key, open);
            output.push(item);
            send("response.output_item.added", { output_index: open.index, item });
          }
          const args = str(fn.arguments);
          if (args !== "") {
            open.text += args;
            send("response.function_call_arguments.delta", { item_id: open.item.id, output_index: open.index, delta: args });
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    },
    async cancel() {
      await it.return?.(undefined).catch(() => undefined);
    },
  });
}

/** A whole chat completion sent as Responses events, for a provider that answered JSON to a stream request. */
export function responseAsEvents(resp: Json): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let seq = 0;
  const out: string[] = [];
  const send = (type: string, data: Json) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  const output = resp.output as Json[];
  const start = { ...resp, status: "in_progress", output: [], usage: null };
  send("response.created", { response: start });
  send("response.in_progress", { response: start });
  output.forEach((item, i) => {
    if (item.type === "message") {
      const t = str((item.content as Json[])[0]?.text);
      send("response.output_item.added", { output_index: i, item: { ...item, status: "in_progress", content: [] } });
      send("response.content_part.added", { item_id: item.id, output_index: i, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send("response.output_text.delta", { item_id: item.id, output_index: i, content_index: 0, delta: t });
      send("response.output_text.done", { item_id: item.id, output_index: i, content_index: 0, text: t });
      send("response.content_part.done", { item_id: item.id, output_index: i, content_index: 0, part: { type: "output_text", text: t, annotations: [] } });
    } else if (item.type === "function_call") {
      send("response.output_item.added", { output_index: i, item: { ...item, arguments: "", status: "in_progress" } });
      send("response.function_call_arguments.delta", { item_id: item.id, output_index: i, delta: item.arguments });
      send("response.function_call_arguments.done", { item_id: item.id, output_index: i, arguments: item.arguments });
    } else send("response.output_item.added", { output_index: i, item });
    send("response.output_item.done", { output_index: i, item });
  });
  send(resp.status === "incomplete" ? "response.incomplete" : "response.completed", { response: resp });
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(out.join("")));
      ctrl.close();
    },
  });
}

/** POST /v1/responses: translate, route as chat, translate the answer back. Errors keep the chat error format. */
export async function runResponses(c: Context<AppEnv>, upstream: Upstream, system: System, req: Json): Promise<Response> {
  let chat: Json;
  try {
    chat = responsesToChat(req);
  } catch (e) {
    if (e instanceof ResponsesError) return errorResponse(400, e.message, "invalid_request_error");
    throw e;
  }
  const res = await runChat(c, upstream, system, chat);
  if (res.status !== 200 || !res.body) return res;
  const headers = new Headers({ "cache-control": "no-store" });
  const target = res.headers.get("x-gateway-target");
  if (target) headers.set("x-gateway-target", target);
  const isStream = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  if (isStream) {
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(chatStreamToResponses(req, res.body), { status: 200, headers });
  }
  let completion: unknown;
  try {
    completion = await res.json();
  } catch {
    return errorResponse(502, "the provider answer was not JSON", "api_error");
  }
  const resp = chatToResponse(req, isObj(completion) ? completion : {});
  if (req.stream === true) {
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(responseAsEvents(resp), { status: 200, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(resp), { status: 200, headers });
}
