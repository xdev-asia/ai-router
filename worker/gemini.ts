import { Hono, type Context } from "hono";
import type { AppEnv } from "./env";
import type { System } from "./auth";
import { sendEmbeddings } from "./media";
import { LEVEL_TO_BUDGET, levelOfBudget, listModels } from "./models";
import { allowedPatterns, allows, targetName } from "./providers";
import { checkSystem, type GateFailure, type Upstream } from "./proxy";
import { resolveModel, runChat } from "./route";
import { TranslateError } from "./translate/openai-anthropic";

/**
 * Gemini API surface (Google Generative Language, v1beta): Gemini CLI and the Google GenAI SDKs call
 * `<base>/v1beta/models/{model}:generateContent` with the gateway token as the API key. Each request is turned
 * into a chat completions request, run by runChat (route.ts) like /v1/chat/completions, and the answer turned back.
 * `{model}` is `<provider>/<model>`, `combo/<name>` or any name runChat knows; `/` may be sent as `%2F`.
 */

type Json = Record<string, unknown>;

const STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};
const statusName = (code: number) => STATUS[code] ?? (code >= 500 ? "INTERNAL" : code >= 400 ? "FAILED_PRECONDITION" : "UNKNOWN");

/** Google's error shape: `{error: {code, message, status}}`. */
function googleError(code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message, status: statusName(code) } }), {
    status: code,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

const gateError = (g: GateFailure) => googleError(g.status, g.message, g.noRetry ? { "x-should-retry": "false" } : {});

/** A runChat failure (OpenAI error shape) in Google's shape, with the same status. */
async function fromChatError(res: Response): Promise<Response> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : `upstream error ${res.status}`;
  const headers: Record<string, string> = {};
  for (const h of ["retry-after", "x-should-retry"]) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return googleError(res.status, message, headers);
}

class BadRequest extends Error {}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Gemini schemas name types in upper case (`OBJECT`); JSON Schema wants lower case. */
function lowerTypes(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(lowerTypes);
  if (!isObj(v)) return v;
  const out: Json = {};
  for (const [k, x] of Object.entries(v)) out[k] = k === "type" && typeof x === "string" ? x.toLowerCase() : lowerTypes(x);
  return out;
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  const parts = isObj(v) && Array.isArray(v.parts) ? v.parts : Array.isArray(v) ? v : [];
  return parts.flatMap((p) => (isObj(p) && typeof p.text === "string" ? [p.text] : [])).join("\n");
}

function mediaPart(mimeType: unknown, url: string): Json {
  if (typeof mimeType === "string" && mimeType.startsWith("image/")) return { type: "image_url", image_url: { url } };
  throw new BadRequest(`unsupported media type ${typeof mimeType === "string" ? mimeType : "(none)"}: only images are supported`);
}

/** A GenerateContentRequest as an OpenAI chat completions request for `model`. Throws BadRequest. */
export function geminiToChat(body: Json, model: string, stream: boolean): Json {
  if (!Array.isArray(body.contents) || body.contents.length === 0) throw new BadRequest("contents must be a non-empty array");
  const messages: Json[] = [];
  const system = body.systemInstruction ?? body.system_instruction;
  if (system !== undefined) {
    const s = textOf(system);
    if (s) messages.push({ role: "system", content: s });
  }

  // Gemini matches a functionResponse to its functionCall by name (and `id` when there is one).
  const pending: { id: string; name: string }[] = [];
  let n = 0;
  for (const content of body.contents) {
    if (!isObj(content) || !Array.isArray(content.parts)) throw new BadRequest("each content needs parts");
    const role = content.role === "model" ? "assistant" : "user";
    const parts: Json[] = [];
    const calls: Json[] = [];
    const results: Json[] = [];
    for (const p of content.parts) {
      if (!isObj(p)) throw new BadRequest("each part must be an object");
      if (p.thought === true) continue;
      if (typeof p.text === "string") parts.push({ type: "text", text: p.text });
      else if (isObj(p.inlineData)) parts.push(mediaPart(p.inlineData.mimeType, `data:${String(p.inlineData.mimeType)};base64,${String(p.inlineData.data ?? "")}`));
      else if (isObj(p.fileData) && typeof p.fileData.fileUri === "string") parts.push(mediaPart(p.fileData.mimeType, p.fileData.fileUri));
      else if (isObj(p.functionCall) && typeof p.functionCall.name === "string") {
        const id = typeof p.functionCall.id === "string" && p.functionCall.id ? p.functionCall.id : `call_${n++}`;
        pending.push({ id, name: p.functionCall.name });
        calls.push({ id, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } });
      } else if (isObj(p.functionResponse) && typeof p.functionResponse.name === "string") {
        const fr = p.functionResponse;
        const at = pending.findIndex((c) => (typeof fr.id === "string" && fr.id ? c.id === fr.id : c.name === fr.name));
        const id = at >= 0 ? pending.splice(at, 1)[0]!.id : typeof fr.id === "string" && fr.id ? fr.id : `call_${n++}`;
        results.push({ role: "tool", tool_call_id: id, content: JSON.stringify(fr.response ?? {}) });
      }
    }
    const text = parts.length === 1 && parts[0]!.type === "text" ? (parts[0]!.text as string) : null;
    if (role === "assistant") {
      if (parts.length === 0 && calls.length === 0) continue;
      const allText = parts.every((p) => p.type === "text");
      const msg: Json = { role, content: parts.length === 0 ? null : allText ? parts.map((p) => p.text).join("") : parts };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
    } else {
      messages.push(...results);
      if (parts.length) messages.push({ role, content: text ?? parts });
    }
  }

  const req: Json = { model, messages };
  const tools: Json[] = [];
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (!isObj(t) || !Array.isArray(t.functionDeclarations)) continue;
      for (const f of t.functionDeclarations) {
        if (!isObj(f) || typeof f.name !== "string") continue;
        const fn: Json = { name: f.name };
        if (typeof f.description === "string") fn.description = f.description;
        const params = f.parametersJsonSchema ?? f.parameters;
        if (isObj(params)) fn.parameters = f.parametersJsonSchema ? params : lowerTypes(params);
        tools.push({ type: "function", function: fn });
      }
    }
  }
  if (tools.length) req.tools = tools;
  const fcc = isObj(body.toolConfig) && isObj(body.toolConfig.functionCallingConfig) ? body.toolConfig.functionCallingConfig : null;
  if (fcc && tools.length) {
    const names = Array.isArray(fcc.allowedFunctionNames) ? fcc.allowedFunctionNames.filter((x): x is string => typeof x === "string") : [];
    if (fcc.mode === "NONE") req.tool_choice = "none";
    else if (fcc.mode === "AUTO") req.tool_choice = "auto";
    else if (fcc.mode === "ANY" || fcc.mode === "VALIDATED") req.tool_choice = names.length === 1 ? { type: "function", function: { name: names[0] } } : "required";
  }

  const g = isObj(body.generationConfig) ? body.generationConfig : {};
  if (typeof g.temperature === "number") req.temperature = g.temperature;
  if (typeof g.topP === "number") req.top_p = g.topP;
  if (typeof g.maxOutputTokens === "number") req.max_tokens = g.maxOutputTokens;
  if (Array.isArray(g.stopSequences) && g.stopSequences.length) req.stop = g.stopSequences;
  if (typeof g.presencePenalty === "number") req.presence_penalty = g.presencePenalty;
  if (typeof g.frequencyPenalty === "number") req.frequency_penalty = g.frequencyPenalty;
  if (typeof g.seed === "number") req.seed = g.seed;
  const schema = g.responseJsonSchema ?? g.responseSchema;
  if (isObj(schema)) req.response_format = { type: "json_schema", json_schema: { name: "response", schema: g.responseJsonSchema ? schema : lowerTypes(schema) } };
  else if (g.responseMimeType === "application/json") req.response_format = { type: "json_object" };
  // [Inference] Gemini's thinking budget, read with the gateway's own budget-to-level rule (models.ts).
  // -1 (dynamic) and 0 (off) leave it to the provider's default.
  const tc = isObj(g.thinkingConfig) ? g.thinkingConfig : {};
  if (typeof tc.thinkingBudget === "number" && tc.thinkingBudget > 0) {
    const level = levelOfBudget(tc.thinkingBudget);
    if (level !== "none") req.reasoning_effort = level;
  } else if (typeof tc.thinkingLevel === "string" && ["minimal", "low", "medium", "high"].includes(tc.thinkingLevel.toLowerCase())) {
    req.reasoning_effort = tc.thinkingLevel.toLowerCase();
  }
  if (stream) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }
  return req;
}

const FINISH: Record<string, string> = { stop: "STOP", length: "MAX_TOKENS", tool_calls: "STOP", function_call: "STOP", content_filter: "SAFETY" };
const finishOf = (r: unknown) => (typeof r === "string" ? FINISH[r] ?? "OTHER" : undefined);

function usageMetadata(u: unknown): Json | undefined {
  if (!isObj(u)) return undefined;
  const prompt = Number(u.prompt_tokens) || 0;
  const out = Number(u.completion_tokens) || 0;
  const m: Json = { promptTokenCount: prompt, candidatesTokenCount: out, totalTokenCount: Number(u.total_tokens) || prompt + out };
  const cached = isObj(u.prompt_tokens_details) ? Number(u.prompt_tokens_details.cached_tokens) || 0 : 0;
  if (cached) m.cachedContentTokenCount = cached;
  const thoughts = isObj(u.completion_tokens_details) ? Number(u.completion_tokens_details.reasoning_tokens) || 0 : 0;
  if (thoughts) m.thoughtsTokenCount = thoughts;
  return m;
}

function parseArgs(s: unknown): unknown {
  if (typeof s !== "string" || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

const callPart = (id: unknown, name: unknown, args: unknown): Json => ({
  functionCall: { ...(typeof id === "string" && id ? { id } : {}), name: typeof name === "string" ? name : "", args: parseArgs(args) },
});

function response(parts: Json[], finish: string | undefined, usage: Json | undefined, model: unknown, id: unknown): Json {
  const cand: Json = { content: { role: "model", parts } };
  if (finish) cand.finishReason = finish;
  cand.index = 0;
  const out: Json = { candidates: [cand] };
  if (usage) out.usageMetadata = usage;
  if (typeof model === "string") out.modelVersion = model;
  if (typeof id === "string") out.responseId = id;
  return out;
}

/** A chat.completion as a GenerateContentResponse. */
export function chatToGemini(c: Json): Json {
  const choice = Array.isArray(c.choices) && isObj(c.choices[0]) ? c.choices[0] : {};
  const msg = isObj(choice.message) ? choice.message : {};
  const parts: Json[] = [];
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (typeof reasoning === "string" && reasoning) parts.push({ text: reasoning, thought: true });
  if (typeof msg.content === "string" && msg.content) parts.push({ text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const t of msg.tool_calls) if (isObj(t) && isObj(t.function)) parts.push(callPart(t.id, t.function.name, t.function.arguments));
  }
  return response(parts, finishOf(choice.finish_reason), usageMetadata(c.usage), c.model, c.id);
}

/**
 * Chat completion chunks (SSE) as GenerateContentResponse chunks. Text goes out as it comes; tool calls are put
 * together from their fragments and go out with the finish reason and usage in one last chunk.
 */
function streamToGemini(body: ReadableStream<Uint8Array>, sse: boolean): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let first = true;
  let model: unknown;
  let id: unknown;
  let finish: string | undefined;
  let usage: Json | undefined;
  let failed = false;
  const tools = new Map<number, { id?: string; name?: string; args: string }>();

  const emit = (ctrl: TransformStreamDefaultController<Uint8Array>, obj: Json) => {
    if (sse) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
    else {
      ctrl.enqueue(enc.encode((first ? "[" : ",\n") + JSON.stringify(obj)));
      first = false;
    }
  };

  const onData = (data: string, ctrl: TransformStreamDefaultController<Uint8Array>) => {
    if (failed || data === "[DONE]") return;
    let ch: Json;
    try {
      ch = JSON.parse(data) as Json;
    } catch {
      return;
    }
    if (isObj(ch.error)) {
      failed = true;
      const message = typeof ch.error.message === "string" ? ch.error.message : "the stream from the provider failed";
      emit(ctrl, { error: { code: 500, message, status: "INTERNAL" } });
      return;
    }
    if (typeof ch.model === "string") model = ch.model;
    if (typeof ch.id === "string") id = ch.id;
    if (ch.usage) usage = usageMetadata(ch.usage) ?? usage;
    const choice = Array.isArray(ch.choices) && isObj(ch.choices[0]) ? ch.choices[0] : null;
    if (!choice) return;
    const d = isObj(choice.delta) ? choice.delta : {};
    const parts: Json[] = [];
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (typeof reasoning === "string" && reasoning) parts.push({ text: reasoning, thought: true });
    if (typeof d.content === "string" && d.content) parts.push({ text: d.content });
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        if (!isObj(t)) continue;
        const i = typeof t.index === "number" ? t.index : tools.size;
        const cur = tools.get(i) ?? { args: "" };
        if (typeof t.id === "string") cur.id = t.id;
        const f = isObj(t.function) ? t.function : {};
        if (typeof f.name === "string") cur.name = f.name;
        if (typeof f.arguments === "string") cur.args += f.arguments;
        tools.set(i, cur);
      }
    }
    if (parts.length) emit(ctrl, response(parts, undefined, undefined, model, id));
    finish = finishOf(choice.finish_reason) ?? finish;
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split("\n")) if (line.startsWith("data:")) onData(line.slice(5).trim(), ctrl);
        }
      },
      flush(ctrl) {
        buf += dec.decode();
        for (const line of buf.split("\n")) if (line.startsWith("data:")) onData(line.slice(5).trim(), ctrl);
        if (!failed) {
          const parts = [...tools.entries()].sort(([a], [b]) => a - b).map(([, t]) => callPart(t.id, t.name, t.args));
          if (parts.length || finish || usage) emit(ctrl, response(parts, finish ?? "STOP", usage, model, id));
        }
        if (!sse) ctrl.enqueue(enc.encode(first ? "[]" : "]"));
      },
    }),
  );
}

/*
 * The other direction, for providers that speak Gemini (Cloud Code: Gemini CLI and Antigravity, cloudcode.ts):
 * a chat completions request as a GenerateContentRequest, and Gemini's answer and stream as a chat completion
 * and a chat stream. Adapted from the openai-to-gemini and gemini-to-openai translators of an MIT-licensed
 * gateway; see THIRD_PARTY_NOTICES.md.
 */

/** JSON Schema keywords Gemini's schema has no field for; one of them anywhere refuses the whole request. */
const SCHEMA_DROP = new Set([
  "$schema", "$id", "$defs", "definitions", "$ref", "$comment", "const", "default", "examples", "title",
  "additionalProperties", "patternProperties", "propertyNames", "minProperties", "maxProperties",
  "unevaluatedProperties", "unevaluatedItems", "dependencies", "dependentSchemas", "dependentRequired",
  "minLength", "maxLength", "pattern", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "format",
  "uniqueItems", "contains", "prefixItems", "additionalItems", "minItems", "maxItems",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "deprecated", "readOnly", "writeOnly",
  "contentMediaType", "contentEncoding", "contentSchema",
]);

/** A JSON Schema as Gemini's OpenAPI subset: one type (null as `nullable`), `const` as `enum`, unions as their first branch. */
function geminiSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(geminiSchema);
  if (!isObj(v)) return v;
  let s: Json = { ...v };
  // allOf: the branches merged; anyOf/oneOf: the first branch that is not null, nullable when a null one is there.
  if (Array.isArray(s.allOf)) for (const b of s.allOf) if (isObj(b)) s = { ...b, ...s, properties: { ...(isObj(b.properties) ? b.properties : {}), ...(isObj(s.properties) ? s.properties : {}) } };
  for (const k of ["anyOf", "oneOf"]) {
    const branches = Array.isArray(s[k]) ? (s[k] as unknown[]).filter(isObj) : [];
    if (!branches.length) continue;
    const real = branches.filter((b) => b.type !== "null");
    if (real.length < branches.length) s.nullable = true;
    if (real[0] && s.type === undefined) s = { ...real[0], ...s };
  }
  if (Array.isArray(s.type)) {
    const types = s.type.filter((t): t is string => typeof t === "string");
    if (types.includes("null")) s.nullable = true;
    s.type = types.find((t) => t !== "null") ?? "string";
  }
  if (s.const !== undefined && s.enum === undefined) s.enum = [s.const];
  if (Array.isArray(s.enum)) s.enum = s.enum.filter((e) => e !== null).map(String);
  if (s.type === undefined && isObj(s.properties)) s.type = "object";
  if (s.type === "array" && !isObj(s.items)) s.items = { type: "string" };
  const out: Json = {};
  for (const [k, x] of Object.entries(s)) {
    if (SCHEMA_DROP.has(k) || k.startsWith("x-")) continue;
    // Property names are names, not keywords: only their schemas are cleaned.
    if (k === "properties" && isObj(x)) out[k] = Object.fromEntries(Object.entries(x).map(([n, p]) => [n, geminiSchema(p)]));
    else out[k] = geminiSchema(x);
  }
  if (Array.isArray(out.required) && isObj(out.properties)) {
    const props = out.properties;
    const req = out.required.filter((n): n is string => typeof n === "string" && n in props);
    if (req.length) out.required = req;
    else delete out.required;
  }
  return out;
}

/** Text of a chat message's content: a string, or the text of its text parts. */
function chatText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v.flatMap((p) => (isObj(p) && typeof p.text === "string" ? [p.text] : [])).join("\n");
}

function chatParts(v: unknown): Json[] {
  if (typeof v === "string") return v ? [{ text: v }] : [];
  if (!Array.isArray(v)) return [];
  const parts: Json[] = [];
  for (const p of v) {
    if (!isObj(p)) continue;
    if (p.type === "text" && typeof p.text === "string") {
      if (p.text) parts.push({ text: p.text });
    } else if (p.type === "image_url") {
      const url = isObj(p.image_url) ? p.image_url.url : p.image_url;
      const m = typeof url === "string" ? /^data:([^;,]+);base64,(.*)$/s.exec(url) : null;
      if (!m) throw new TranslateError("image_url: this provider takes images as data: URLs (base64) only");
      parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    } else throw new TranslateError(`content part type ${JSON.stringify(p.type)} is not supported by this provider`);
  }
  return parts;
}

function toolResponse(content: unknown): Json {
  const text = chatText(content);
  try {
    const v = JSON.parse(text) as unknown;
    if (isObj(v)) return v;
  } catch {
    // not JSON
  }
  return { result: text };
}

/** Gemini 3 takes a thinking level; older models a token budget (2.5 Pro's top is 32768). */
function thinkingConfig(model: string, effort: string): Json | null {
  const e = effort.toLowerCase();
  if (/gemini-3/i.test(model)) {
    const level = e === "none" || e === "off" || e === "minimal" ? "minimal" : e === "xhigh" || e === "max" ? "high" : ["low", "medium", "high"].includes(e) ? e : null;
    return level ? { thinkingLevel: level, includeThoughts: true } : null;
  }
  if (e === "none" || e === "off") return { thinkingBudget: 0 };
  const budget = (LEVEL_TO_BUDGET as Record<string, number>)[e];
  return budget ? { thinkingBudget: Math.min(budget, 32768), includeThoughts: true } : null;
}

/** An OpenAI chat completions request as a GenerateContentRequest (no model: the caller's URL or envelope names it). Throws TranslateError. */
export function chatToGeminiRequest(req: Json): Json {
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new TranslateError("messages must be a non-empty array");
  const model = typeof req.model === "string" ? req.model : "";
  const system: string[] = [];
  const contents: Json[] = [];
  const names = new Map<string, string>();
  let answers: Json | null = null;
  for (const m of req.messages) {
    if (!isObj(m)) throw new TranslateError("each message must be an object");
    if (m.role === "system" || m.role === "developer") {
      const t = chatText(m.content);
      if (t) system.push(t);
      continue;
    }
    if (m.role === "tool") {
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      const part = { functionResponse: { name: names.get(id) ?? (typeof m.name === "string" ? m.name : "tool"), response: toolResponse(m.content) } };
      // Gemini wants every answer to one model turn in one user content.
      if (answers) (answers.parts as Json[]).push(part);
      else contents.push((answers = { role: "user", parts: [part] }));
      continue;
    }
    answers = null;
    if (m.role === "assistant") {
      const parts = chatParts(m.content);
      for (const t of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isObj(t) || !isObj(t.function) || typeof t.function.name !== "string") continue;
        if (typeof t.id === "string") names.set(t.id, t.function.name);
        const part: Json = { functionCall: { name: t.function.name, args: parseArgs(t.function.arguments) } };
        const google = isObj(t.extra_content) && isObj(t.extra_content.google) ? t.extra_content.google : null;
        if (typeof google?.thought_signature === "string") part.thoughtSignature = google.thought_signature;
        parts.push(part);
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    const parts = chatParts(m.content);
    if (parts.length) contents.push({ role: "user", parts });
  }
  if (!contents.length) throw new TranslateError("messages: at least one user or assistant message with content is needed");

  const out: Json = { contents };
  if (system.length) out.systemInstruction = { role: "user", parts: [{ text: system.join("\n\n") }] };

  const decls: Json[] = [];
  for (const t of Array.isArray(req.tools) ? req.tools : []) {
    if (!isObj(t) || !isObj(t.function) || typeof t.function.name !== "string") continue;
    const d: Json = { name: t.function.name };
    if (typeof t.function.description === "string") d.description = t.function.description;
    if (isObj(t.function.parameters)) d.parameters = geminiSchema(t.function.parameters);
    decls.push(d);
  }
  if (decls.length) out.tools = [{ functionDeclarations: decls }];
  const tc = req.tool_choice;
  if (decls.length && tc !== undefined) {
    if (tc === "none") out.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (tc === "auto") out.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    else if (tc === "required") out.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (isObj(tc) && isObj(tc.function) && typeof tc.function.name === "string") out.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tc.function.name] } };
  }

  const g: Json = {};
  if (typeof req.temperature === "number") g.temperature = req.temperature;
  if (typeof req.top_p === "number") g.topP = req.top_p;
  const max = req.max_completion_tokens ?? req.max_tokens;
  if (typeof max === "number") g.maxOutputTokens = max;
  const stop = typeof req.stop === "string" ? [req.stop] : Array.isArray(req.stop) ? req.stop.filter((x): x is string => typeof x === "string") : [];
  if (stop.length) g.stopSequences = stop;
  if (typeof req.seed === "number") g.seed = req.seed;
  if (typeof req.presence_penalty === "number") g.presencePenalty = req.presence_penalty;
  if (typeof req.frequency_penalty === "number") g.frequencyPenalty = req.frequency_penalty;
  const rf = isObj(req.response_format) ? req.response_format : null;
  if (rf?.type === "json_object") g.responseMimeType = "application/json";
  else if (rf?.type === "json_schema") {
    g.responseMimeType = "application/json";
    const schema = isObj(rf.json_schema) ? rf.json_schema.schema : undefined;
    if (isObj(schema)) g.responseSchema = geminiSchema(schema);
  }
  const effort = typeof req.reasoning_effort === "string" ? req.reasoning_effort : isObj(req.reasoning) && typeof req.reasoning.effort === "string" ? req.reasoning.effort : null;
  const thinking = effort ? thinkingConfig(model, effort) : null;
  if (thinking) g.thinkingConfig = thinking;
  if (Object.keys(g).length) out.generationConfig = g;
  return out;
}

const CHAT_FINISH: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  IMAGE_SAFETY: "content_filter",
};

/** Gemini's usageMetadata as OpenAI usage; thoughts count as completion tokens, as OpenAI counts reasoning. */
function chatUsage(u: unknown): Json | undefined {
  if (!isObj(u)) return undefined;
  const prompt = Number(u.promptTokenCount) || 0;
  const thoughts = Number(u.thoughtsTokenCount) || 0;
  const completion = (Number(u.candidatesTokenCount) || 0) + thoughts;
  const out: Json = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(u.totalTokenCount) || prompt + completion };
  const cached = Number(u.cachedContentTokenCount) || 0;
  if (cached) out.prompt_tokens_details = { cached_tokens: cached };
  if (thoughts) out.completion_tokens_details = { reasoning_tokens: thoughts };
  return out;
}

/** Cloud Code wraps Gemini's answer in `{response: ...}`. */
const unwrap = (v: unknown): Json => (isObj(v) && isObj(v.response) ? v.response : isObj(v) ? v : {});

const callId = () => `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

function toolCallOf(p: Json, index: number): Json | null {
  if (!isObj(p.functionCall) || typeof p.functionCall.name !== "string") return null;
  const call: Json = {
    index,
    id: typeof p.functionCall.id === "string" && p.functionCall.id ? p.functionCall.id : callId(),
    type: "function",
    function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
  };
  if (typeof p.thoughtSignature === "string") call.extra_content = { google: { thought_signature: p.thoughtSignature } };
  return call;
}

/** A GenerateContentResponse (bare or in Cloud Code's envelope) as a chat.completion for `model`. */
export function geminiToChatResponse(answer: unknown, model: string): Json {
  const g = unwrap(answer);
  const cand = Array.isArray(g.candidates) && isObj(g.candidates[0]) ? g.candidates[0] : {};
  const parts = isObj(cand.content) && Array.isArray(cand.content.parts) ? cand.content.parts.filter(isObj) : [];
  let text = "";
  let thoughts = "";
  const calls: Json[] = [];
  for (const p of parts) {
    const call = toolCallOf(p, calls.length);
    if (call) calls.push(call);
    else if (typeof p.text === "string") {
      if (p.thought === true) thoughts += p.text;
      else text += p.text;
    }
  }
  const message: Json = { role: "assistant", content: text || (calls.length ? null : "") };
  if (thoughts) message.reasoning_content = thoughts;
  if (calls.length) message.tool_calls = calls;
  const finish = calls.length ? "tool_calls" : typeof cand.finishReason === "string" ? CHAT_FINISH[cand.finishReason] ?? "stop" : "stop";
  const out: Json = {
    id: `chatcmpl-${typeof g.responseId === "string" ? g.responseId : crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
  const usage = chatUsage(g.usageMetadata);
  if (usage) out.usage = usage;
  return out;
}

/**
 * Gemini's SSE stream (`alt=sse`, bare or in Cloud Code's envelope) as a chat completions stream: text and thoughts
 * as deltas when they come, each function call whole, then the finish reason, one usage chunk (`choices: []`) and
 * `[DONE]`. An error inside the stream goes out as an `{error}` event and ends it.
 */
export function geminiStreamToChat(body: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let buf = "";
  let role = true;
  let calls = 0;
  let finish: string | null = null;
  let usage: Json | undefined;
  let failed = false;

  const send = (ctrl: TransformStreamDefaultController<Uint8Array>, obj: Json | string) => ctrl.enqueue(enc.encode(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`));
  const chunk = (choices: Json[], extra: Json = {}): Json => ({ id, object: "chat.completion.chunk", created, model, choices, ...extra });

  const onData = (data: string, ctrl: TransformStreamDefaultController<Uint8Array>) => {
    if (failed || !data || data === "[DONE]") return;
    let ev: unknown;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (isObj(ev) && isObj(ev.error)) {
      failed = true;
      const e = ev.error;
      send(ctrl, { error: { message: typeof e.message === "string" ? e.message : "the stream from the provider failed", type: "api_error", code: typeof e.code === "number" ? e.code : 502 } });
      return;
    }
    const g = unwrap(ev);
    usage = chatUsage(g.usageMetadata) ?? usage;
    const cand = Array.isArray(g.candidates) && isObj(g.candidates[0]) ? g.candidates[0] : null;
    if (!cand) return;
    const delta: Json = {};
    const toolCalls: Json[] = [];
    for (const p of isObj(cand.content) && Array.isArray(cand.content.parts) ? cand.content.parts.filter(isObj) : []) {
      const call = toolCallOf(p, calls);
      if (call) {
        calls++;
        toolCalls.push(call);
      } else if (typeof p.text === "string" && p.text) {
        const k = p.thought === true ? "reasoning_content" : "content";
        delta[k] = ((delta[k] as string | undefined) ?? "") + p.text;
      }
    }
    if (toolCalls.length) delta.tool_calls = toolCalls;
    if (Object.keys(delta).length) {
      send(ctrl, chunk([{ index: 0, delta: role ? { role: "assistant", ...delta } : delta, finish_reason: null }]));
      role = false;
    }
    if (typeof cand.finishReason === "string") finish = CHAT_FINISH[cand.finishReason] ?? "stop";
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, ctrl) {
        buf += dec.decode(bytes, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          onData(block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""), ctrl);
        }
      },
      flush(ctrl) {
        buf += dec.decode();
        onData(buf.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""), ctrl);
        if (!failed) {
          send(ctrl, chunk([{ index: 0, delta: role ? { role: "assistant" } : {}, finish_reason: calls ? "tool_calls" : finish ?? "stop" }]));
          if (usage) send(ctrl, chunk([], { usage }));
        }
        send(ctrl, "[DONE]");
      },
    }),
  );
}

/** `{model}` and the method from the path: `/v1beta/models/<model>:<method>`, `<model>` URL-decoded, `models/` taken off. */
function target(c: Context<AppEnv>): { model: string; method: string } | null {
  const rest = new URL(c.req.url).pathname.replace(/^.*?\/models\//, "");
  const at = rest.lastIndexOf(":");
  if (at <= 0) return null;
  let model: string;
  try {
    model = decodeURIComponent(rest.slice(0, at));
  } catch {
    return null;
  }
  model = model.replace(/^models\//, "");
  return model ? { model, method: rest.slice(at + 1) } : null;
}

const METHODS = new Set(["generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents"]);
const SERVED = "this gateway serves models/{model}:generateContent, :streamGenerateContent, :countTokens, :embedContent and :batchEmbedContents here";

/** The text a GenerateContentRequest sends: system instruction, contents (text, function calls and answers) and tool declarations. */
function requestText(body: Json): string {
  const out: string[] = [];
  if (body.systemInstruction !== undefined) out.push(textOf(body.systemInstruction));
  for (const m of Array.isArray(body.contents) ? body.contents : []) {
    if (!isObj(m) || !Array.isArray(m.parts)) continue;
    for (const p of m.parts) {
      if (!isObj(p)) continue;
      if (typeof p.text === "string") out.push(p.text);
      else if (p.functionCall !== undefined) out.push(JSON.stringify(p.functionCall));
      else if (p.functionResponse !== undefined) out.push(JSON.stringify(p.functionResponse));
    }
  }
  if (Array.isArray(body.tools)) out.push(JSON.stringify(body.tools));
  return out.join("\n");
}

/**
 * countTokens: an estimate (about 4 characters a token, images not counted), not the provider's tokenizer, since
 * the model behind `{model}` may be any provider's. The request is not sent anywhere.
 */
async function countTokens(c: Context<AppEnv>, system: System, model: string, body: Json): Promise<Response> {
  const resolved = await resolveModel(c.env.DB, model);
  if (!resolved) return googleError(404, "unknown model: use provider/model, claude-*, or combo/<name>");
  const name = resolved.ref.kind === "combo" ? `combo/${resolved.ref.name}` : targetName(resolved.ref.target);
  if (!allows(allowedPatterns(system.allowed_models), name)) return googleError(403, `this system may not use ${name}`);
  const req = isObj(body.generateContentRequest) ? body.generateContentRequest : body;
  const totalTokens = Math.ceil(requestText(req).length / 4);
  return Response.json({ totalTokens }, { headers: { "cache-control": "no-store" } });
}

/** embedContent and batchEmbedContents, sent as one OpenAI embeddings request (media.ts) and answered in Gemini's shape. */
async function embed(c: Context<AppEnv>, upstream: Upstream, system: System, model: string, body: Json, batch: boolean): Promise<Response> {
  const items = batch ? (Array.isArray(body.requests) ? body.requests : []) : [body];
  const texts = items.map((it) => (isObj(it) ? textOf(it.content) : ""));
  if (texts.length === 0 || texts.some((x) => !x)) return googleError(400, batch ? "requests: each needs content with text parts" : "content: text parts are required");
  const res = await sendEmbeddings(c, upstream, system, { model, input: batch ? texts : texts[0] });
  if (!res.ok) return fromChatError(res);
  const j = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const data = (Array.isArray(j?.data) ? j.data : []).filter(isObj);
  data.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  const values = data.map((d) => ({ values: Array.isArray(d.embedding) ? d.embedding : [] }));
  if (values.length !== texts.length) return googleError(502, "the provider answered with a different number of embeddings");
  return Response.json(batch ? { embeddings: values } : { embedding: values[0] }, { headers: { "cache-control": "no-store" } });
}

export function geminiRoutes(upstream: Upstream): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /** What this system may call (models.ts listModels, as /v1/models), in Gemini's shape. */
  r.get("/models", async (c) => {
    const g = await checkSystem(c.env, c.req.raw, false);
    if (!g.ok) return gateError(g);
    const models = (await listModels(c.env, upstream, g.system)).map((m) => ({
      name: `models/${m.id}`,
      version: "001",
      displayName: m.id,
      ...(m.context_length ? { inputTokenLimit: m.context_length } : {}),
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
      ...(m.thinking_levels?.length ? { thinking: true } : {}),
    }));
    return Response.json({ models }, { headers: { "cache-control": "no-store" } });
  });

  r.post("/models/*", async (c) => {
    const t = target(c);
    if (!t || !METHODS.has(t.method)) return googleError(404, SERVED);
    // countTokens is free: no cap check, no usage row.
    const g = await checkSystem(c.env, c.req.raw, t.method !== "countTokens");
    if (!g.ok) return gateError(g);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return googleError(400, "body must be JSON");
    }
    if (!isObj(body)) return googleError(400, "body must be a JSON object");
    if (t.method === "countTokens") return countTokens(c, g.system, t.model, body);
    if (t.method === "embedContent" || t.method === "batchEmbedContents") return embed(c, upstream, g.system, t.model, body, t.method === "batchEmbedContents");
    const stream = t.method === "streamGenerateContent";
    let req: Json;
    try {
      req = geminiToChat(body, t.model, stream);
    } catch (e) {
      if (e instanceof BadRequest) return googleError(400, e.message);
      throw e;
    }
    const res = await runChat(c, upstream, g.system, req);
    if (!res.ok) return fromChatError(res);
    if (!stream) return Response.json(chatToGemini((await res.json()) as Json), { headers: { "cache-control": "no-store" } });
    if (!res.body) return googleError(502, "the provider answered with no body");
    const sse = c.req.query("alt") === "sse";
    return new Response(streamToGemini(res.body, sse), {
      headers: { "content-type": sse ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  });

  r.all("*", () => googleError(404, `this gateway serves GET models and ${SERVED.replace("this gateway serves ", "")}`));
  return r;
}
