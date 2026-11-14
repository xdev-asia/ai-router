import { useEffect, useRef, useState } from "react";
import { Banner, Button, Card, Comment, Composer, EmptyState, IconButton, ListRow, Select, Stack } from "@xdev-asia/ui";
import { ApiError, api, setAuth, useLoad, type System } from "../api";
import { t } from "../i18n";

/** One turn of a chat. `images` are data URLs the user attached; `error` marks a reply that failed. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  error?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  /** Last change, unix ms. */
  at: number;
  messages: ChatMessage[];
}

interface Saved {
  active: string | null;
  sessions: ChatSession[];
  system?: string;
  model?: string;
}

/** Chats are kept in this browser only; the gateway keeps no conversation. */
export const CHAT_KEY = "ai-router.chat";
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 1_000_000;

function readSaved(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "null") as Saved | null;
    if (v && Array.isArray(v.sessions)) return v;
  } catch {
    // A broken entry starts over.
  }
  return { active: null, sessions: [] };
}

function writeSaved(s: Saved): void {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(s));
  } catch {
    // Full or blocked storage: the chat still works for this visit.
  }
}

export const loadSessions = (): ChatSession[] => readSaved().sessions;

/** The text in one `data:` line of an OpenAI chat stream, or "" when it has none. */
export function deltaText(data: string): string {
  try {
    const v = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
    const c = v.choices?.[0]?.delta?.content;
    return typeof c === "string" ? c : "";
  } catch {
    return "";
  }
}

/** What goes to the gateway for one message: plain text, or text and images as OpenAI content parts. */
function wire(m: ChatMessage): { role: string; content: unknown } {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return { role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map((url) => ({ type: "image_url", image_url: { url } }))] };
}

const newSession = (): ChatSession => ({ id: crypto.randomUUID(), title: t("chat.untitled"), at: Date.now(), messages: [] });

/** The gateway's own words for a failed chat, or a generic line. */
async function failure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } | string } | null;
  const e = body?.error;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  return t("error.generic");
}

/**
 * Basic chat: talk to any model the gateway routes, as one of your systems, so its allowed models,
 * savers and monthly cap apply and the usage lands on it. Replies stream in; conversations stay in this browser.
 */
export function BasicChat() {
  const [systems] = useLoad<System[]>("/systems");
  const [saved, setSaved] = useState<Saved>(readSaved);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [imageError, setImageError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const usable = systems.status === "ready" ? systems.data.filter((s) => !s.disabled) : [];
  const system = usable.find((s) => s.id === saved.system)?.id ?? usable[0]?.id ?? null;
  const [models] = useLoad<{ data: { id: string }[] }>(system ? `/chat/models?system=${encodeURIComponent(system)}` : "/chat/models?system=");
  const modelIds = system && models.status === "ready" ? models.data.data.map((m) => m.id) : [];
  const model = modelIds.includes(saved.model ?? "") ? saved.model! : (modelIds[0] ?? "");

  const active = saved.sessions.find((s) => s.id === saved.active) ?? null;

  function update(next: (s: Saved) => Saved) {
    setSaved((prev) => {
      const v = next(prev);
      writeSaved(v);
      return v;
    });
  }

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [active?.messages.length, active?.messages[active.messages.length - 1]?.content]);

  /** Changes the session `id` in place; it moves to the top of the list. */
  function patch(id: string, change: (s: ChatSession) => ChatSession) {
    update((s) => {
      const found = s.sessions.find((x) => x.id === id);
      if (!found) return s;
      const changed = { ...change(found), at: Date.now() };
      return { ...s, sessions: [changed, ...s.sessions.filter((x) => x.id !== id)] };
    });
  }

  function startNew() {
    const n = newSession();
    update((s) => ({ ...s, active: n.id, sessions: [n, ...s.sessions] }));
    setDraft("");
    setImages([]);
  }

  function remove(id: string) {
    update((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      return { ...s, sessions, active: s.active === id ? (sessions[0]?.id ?? null) : s.active };
    });
  }

  async function send() {
    const text = draft.trim();
    if (!text || !system || !model || busy) return;
    let session = active;
    if (!session) {
      session = newSession();
      const n = session;
      update((s) => ({ ...s, active: n.id, sessions: [n, ...s.sessions] }));
    }
    const id = session.id;
    const question: ChatMessage = images.length ? { role: "user", content: text, images } : { role: "user", content: text };
    const history = [...session.messages.filter((m) => !m.error), question];
    const first = session.messages.length === 0;
    patch(id, (s) => ({ ...s, title: first ? text.slice(0, 60) : s.title, messages: [...s.messages, question, { role: "assistant", content: "" }] }));
    setDraft("");
    setImages([]);
    setBusy(true);

    const setReply = (content: string, error = false) =>
      patch(id, (s) => ({ ...s, messages: [...s.messages.slice(0, -1), error ? { role: "assistant", content, error } : { role: "assistant", content }] }));

    try {
      const res = await fetch("/admin/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system, model, stream: true, messages: history.map(wire) }),
      });
      if (res.status === 401) {
        setAuth(null);
        return;
      }
      if (!res.ok || !res.body) {
        setReply(await failure(res), true);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let reply = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        let grew = false;
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          const piece = deltaText(data);
          if (piece) {
            reply += piece;
            grew = true;
          }
        }
        if (grew) setReply(reply);
      }
      if (!reply) setReply(t("chat.empty"), true);
    } catch (e) {
      setReply(e instanceof ApiError && e.detail ? e.detail : t("error.generic"), true);
    } finally {
      setBusy(false);
    }
  }

  function attach(files: FileList | null) {
    setImageError(false);
    for (const f of Array.from(files ?? [])) {
      if (!f.type.startsWith("image/") || f.size > MAX_IMAGE_BYTES) {
        setImageError(true);
        continue;
      }
      const r = new FileReader();
      r.onload = () => typeof r.result === "string" && setImages((xs) => (xs.length < MAX_IMAGES ? [...xs, r.result as string] : xs));
      r.readAsDataURL(f);
    }
  }

  if (systems.status === "ready" && usable.length === 0) {
    return (
      <EmptyState
        icon="key"
        title={t("chat.noSystem")}
        hint={t("chat.noSystemHint")}
        actions={
          <Button variant="primary" href="#/systems">
            {t("nav.systems")}
          </Button>
        }
      />
    );
  }

  return (
    <div className="chat-layout">
      <Card
        title={t("chat.sessions")}
        headingLevel={2}
        actions={
          <Button size="sm" icon="plus" onClick={startNew}>
            {t("chat.new")}
          </Button>
        }
      >
        {saved.sessions.length === 0 ? (
          <span className="muted">{t("chat.noSessions")}</span>
        ) : (
          <ul className="chat-session-list">
            {saved.sessions.map((s) => (
              <ListRow
                key={s.id}
                as="li"
                title={s.title}
                meta={new Date(s.at).toLocaleString()}
                selected={s.id === saved.active}
                onClick={() => update((v) => ({ ...v, active: s.id }))}
                trailing={<IconButton icon="trash" size="sm" label={t("chat.delete", { title: s.title })} onClick={() => remove(s.id)} />}
              />
            ))}
          </ul>
        )}
      </Card>
      <Card
        title={active?.title ?? t("chat.untitled")}
        headingLevel={2}
        actions={
          usable.length > 1 ? (
            <Select
              aria-label={t("chat.system")}
              value={system ?? ""}
              onChange={(e) => update((v) => ({ ...v, system: e.target.value }))}
              options={usable.map((s) => ({ value: s.id, label: s.name }))}
            />
          ) : undefined
        }
      >
        <Stack gap={3}>
          <div className="chat-thread" aria-live="polite">
            {!active || active.messages.length === 0 ? (
              <EmptyState size="inline" icon="chat" title={t("chat.start")} hint={t("chat.startHint", { system: system ?? "" })} />
            ) : (
              active.messages.map((m, i) => (
                <Comment key={i} author={m.role === "user" ? t("chat.you") : model || t("chat.assistant")} bot={m.role === "assistant"}>
                  {m.error ? (
                    <Banner tone="danger" title={m.content} />
                  ) : (
                    <>
                      <p className="chat-text">{m.content || (busy && i === active.messages.length - 1 ? "…" : "")}</p>
                      {m.images?.length ? (
                        <div className="chat-images">
                          {m.images.map((src, j) => (
                            <img key={j} src={src} alt={t("chat.image", { n: String(j + 1) })} />
                          ))}
                        </div>
                      ) : null}
                    </>
                  )}
                </Comment>
              ))
            )}
            <div ref={endRef} />
          </div>
          {models.status === "ready" && modelIds.length === 0 ? <Banner tone="warn" title={t("chat.noModels")} /> : null}
          {imageError ? <Banner tone="warn" title={t("chat.imageTooBig")} /> : null}
          {images.length > 0 ? (
            <div className="chat-images">
              {images.map((src, j) => (
                <span key={j} className="chat-attached">
                  <img src={src} alt={t("chat.image", { n: String(j + 1) })} />
                  <IconButton icon="close" size="sm" label={t("chat.removeImage", { n: String(j + 1) })} onClick={() => setImages((xs) => xs.filter((_, k) => k !== j))} />
                </span>
              ))}
            </div>
          ) : null}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => (attach(e.target.files), (e.target.value = ""))} />
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            disabled={busy || !system || !model}
            placeholder={t("chat.placeholder")}
            model={modelIds.length ? { value: model, options: modelIds.map((m) => ({ value: m, label: m })) } : undefined}
            onModel={(m) => update((v) => ({ ...v, model: m }))}
            onAttach={() => fileRef.current?.click()}
            labels={{ input: t("chat.input"), send: t("chat.send"), attach: t("chat.attach"), model: t("chat.model") }}
          />
        </Stack>
      </Card>
    </div>
  );
}
