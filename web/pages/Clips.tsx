import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Combobox,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FormDialog,
  IconButton,
  Segmented,
  Select,
  Skeleton,
  Stack,
  StatusDot,
  Tabs,
  Textarea,
  type DataTableColumn,
} from "@xdev-asia/ui";
import { ApiError, api, useLoad } from "../api";
import { t, useLang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";

/** Clip Studio (studio/, reached through /admin/studio, worker/studio.ts). Types follow studio/README.md, API. */
type Status = "queued" | "running" | "failed" | "done";
type Step = "script" | "voice" | "assets" | "render" | "done";
type Mode = "image" | "video" | "mixed";

export interface StudioStatus {
  configured: boolean;
  reachable: boolean;
  connected: boolean;
  public_base_url?: string | null;
  can_store?: boolean;
  message?: string;
}

interface ProjectSummary {
  id: string;
  topic: string;
  title: string | null;
  step: Step;
  status: Status;
  error: string | null;
  mode: Mode;
  created_at: number;
}

interface Scene {
  narration: string;
  visual: string;
  kind: "image" | "video";
  duration?: number;
  audio?: string;
  image?: string;
  video?: string;
  note?: string;
}

interface Project extends Omit<ProjectSummary, "title"> {
  language: "vi" | "en";
  duration: number;
  chat_model: string;
  image_model: string;
  video_model: string;
  tts_model: string;
  voice: string;
  image_size: string;
  plan: null | { title: string; description: string; hashtags: string[]; scenes: Scene[] };
  updated_at: number;
}

interface Publication {
  id: string;
  channel_id: string;
  status: "pending" | "running" | "done" | "failed";
  scheduled_at: number;
  url: string | null;
  external_id: string | null;
  error: string | null;
}

interface ProjectDetail {
  project: Project;
  final: null | { video: string; cover: string };
  publications: Publication[];
}

interface ChannelField {
  key: string;
  label: string;
  help?: string;
  optional?: boolean;
}
interface ChannelKind {
  kind: string;
  name: string;
  secretFields: ChannelField[];
  configFields: ChannelField[];
}
interface Channel {
  id: string;
  kind: string;
  name: string;
  config: Record<string, string>;
  created_at: number;
}

export const STUDIO_TABS = ["projects", "channels"] as const;
const BASE = "/studio/api";
/** A project's file as the browser loads it: through /admin, with the console's session. */
export const fileUrl = (id: string, file: string) => `/admin${BASE}/projects/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;

const STATUS_TONE: Record<Status | Publication["status"], "ok" | "warn" | "danger" | "accent" | "neutral"> = {
  queued: "neutral",
  pending: "neutral",
  running: "accent",
  failed: "danger",
  done: "ok",
};
const STATUS_LABEL: Record<Status | Publication["status"], StringKey> = {
  queued: "clips.status.queued",
  pending: "clips.status.pending",
  running: "clips.status.running",
  failed: "clips.status.failed",
  done: "clips.status.done",
};
const STEP_LABEL: Record<Step, StringKey> = {
  script: "clips.step.script",
  voice: "clips.step.voice",
  assets: "clips.step.assets",
  render: "clips.step.render",
  done: "clips.step.done",
};

/** What `#/clips…` names: a tab, or a project id. */
export function clipsRoute(hash: string): { tab: (typeof STUDIO_TABS)[number]; project: string | null } {
  const m = /^#\/clips\/([a-z0-9-]+)/.exec(hash.split("?")[0] ?? "");
  if (!m) return { tab: "projects", project: null };
  if (m[1] === "channels") return { tab: "channels", project: null };
  return /^[0-9a-f-]{36}$/.test(m[1]!) ? { tab: "projects", project: m[1]! } : { tab: "projects", project: null };
}

const errorText = (e: unknown) => (e instanceof ApiError ? (e.detail ?? (e.code && !/^\d+$/.test(e.code) ? e.code : t("error.generic"))) : t("error.generic"));

/**
 * Clips: short vertical clips made from a topic through this gateway (script, voice, images or video, render), then
 * posted to channels. The work runs in the studio service; this page is its console.
 */
export function Clips({ hash }: { hash: string }) {
  useLang();
  const [status, reloadStatus] = useLoad<StudioStatus>("/studio/status");
  const route = clipsRoute(hash);

  if (status.status === "loading") return <Skeleton lines={4} announce labels={{ loading: t("loading") }} />;
  if (status.status === "error") return <Banner tone="danger" title={t("error.load")} action={<Button onClick={reloadStatus}>{t("common.retry")}</Button>} />;
  const s = status.data;
  if (!s.configured) return <EmptyState icon="play" size="center" title={t("clips.notSetUp")} hint={t("clips.notSetUpHint")} />;
  if (!s.reachable)
    return <Banner tone="danger" title={t("clips.unreachable")} action={<Button onClick={reloadStatus}>{t("common.retry")}</Button>}>{s.message ?? null}</Banner>;

  return (
    <Stack gap={4}>
      {!s.connected && <ConnectBanner onDone={reloadStatus} />}
      {route.project ? (
        <ProjectView key={route.project} id={route.project} />
      ) : (
        <>
          <Tabs
            label={t("clips.tabs")}
            idPrefix="clips"
            value={route.tab}
            onChange={(id) => {
              window.location.hash = id === "projects" ? "#/clips" : `#/clips/${id}`;
            }}
            items={STUDIO_TABS.map((id) => ({ id, label: t(id === "projects" ? "clips.tab.projects" : "clips.tab.channels") }))}
          />
          <div role="tabpanel" id={`clips-panel-${route.tab}`} aria-labelledby={`clips-tab-${route.tab}`}>
            {route.tab === "channels" ? <ChannelsPanel canStore={s.can_store !== false} /> : <ProjectsPanel connected={s.connected} />}
          </div>
        </>
      )}
    </Stack>
  );
}

function ConnectBanner({ onDone }: { onDone: () => void }) {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await api("/studio/connect", { method: "POST" });
      notify(t("clips.connected"));
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Banner
      tone="warn"
      title={t("clips.connectTitle")}
      action={
        <Button variant="primary" onClick={() => void connect()} disabled={busy}>
          {busy ? t("clips.connecting") : t("clips.connect")}
        </Button>
      }
    >
      {error ?? t("clips.connectBody")}
    </Banner>
  );
}

function ProjectsPanel({ connected }: { connected: boolean }) {
  const [lang] = useLang();
  const [list, reload] = useLoad<{ projects: ProjectSummary[] }>(`${BASE}/projects`);
  const [creating, setCreating] = useState(false);
  const running = list.status === "ready" && list.data.projects.some((p) => p.status === "running" || p.status === "queued");

  useEffect(() => {
    if (!running) return;
    const h = setInterval(reload, 4000);
    return () => clearInterval(h);
  }, [running, reload]);

  const columns: DataTableColumn<ProjectSummary>[] = [
    {
      key: "title",
      header: t("clips.col.title"),
      cell: (p) => (
        <span className="clips-title">
          <a href={`#/clips/${p.id}`}>{p.title ?? p.topic}</a>
          {p.title && <span className="muted">{p.topic}</span>}
        </span>
      ),
    },
    { key: "mode", header: t("clips.col.mode"), width: "min", hideNarrow: true, cell: (p) => t(`clips.mode.${p.mode}` as StringKey) },
    {
      key: "status",
      header: t("clips.col.status"),
      width: "min",
      cell: (p) => <StatusDot tone={STATUS_TONE[p.status]} pulse={p.status === "running"} label={p.status === "done" ? t(STATUS_LABEL.done) : `${t(STATUS_LABEL[p.status])} · ${t(STEP_LABEL[p.step])}`} />,
    },
    { key: "created", header: t("clips.col.created"), width: "min", hideNarrow: true, cell: (p) => new Date(p.created_at).toLocaleString() },
  ];

  return (
    <Card
      title={t("clips.projects")}
      headingLevel={2}
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)} disabled={!connected}>
          {t("clips.new")}
        </Button>
      }
    >
      {list.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
      {list.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {list.status === "ready" && (
        <DataTable
          caption={t("clips.projects")}
          columns={columns}
          rows={list.data.projects}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.title ?? p.topic}
          labels={ui(lang).dataTable}
          empty={<EmptyState size="inline" icon="play" title={t("clips.none")} hint={t("clips.noneHint")} />}
        />
      )}
      {creating && (
        <NewProjectDialog
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            window.location.hash = `#/clips/${id}`;
          }}
        />
      )}
    </Card>
  );
}

export interface ProjectDraft {
  topic: string;
  language: "vi" | "en";
  duration: string;
  mode: Mode;
  chat_model: string | null;
  image_model: string | null;
  video_model: string | null;
  tts_model: string | null;
  voice: string;
  image_size: string;
}

/** What is wrong with a draft, per field (forms.md: a pure function). */
export function validateProject(d: ProjectDraft): Partial<Record<keyof ProjectDraft, StringKey>> {
  const e: Partial<Record<keyof ProjectDraft, StringKey>> = {};
  if (!d.topic.trim()) e.topic = "clips.err.topic";
  const n = Number(d.duration);
  if (!Number.isInteger(n) || n < 10 || n > 180) e.duration = "clips.err.duration";
  if (!d.chat_model) e.chat_model = "clips.err.model";
  if (d.mode !== "video" && !d.image_model) e.image_model = "clips.err.model";
  if (d.mode !== "image" && !d.video_model) e.video_model = "clips.err.model";
  return e;
}

/** The body of POST /api/projects. */
export function projectBody(d: ProjectDraft): Record<string, unknown> {
  return {
    topic: d.topic.trim(),
    language: d.language,
    duration: Number(d.duration),
    mode: d.mode,
    chat_model: d.chat_model,
    // The studio falls back to an image when a video scene fails, so an image model is sent for every mode.
    image_model: d.image_model ?? "",
    video_model: d.mode === "image" ? "" : d.video_model,
    tts_model: d.tts_model ?? "",
    voice: d.voice.trim(),
    image_size: d.image_size,
  };
}

const IMAGE_SIZES = ["1024x1536", "1024x1792", "768x1344", "1024x1024"];

function NewProjectDialog({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [lang] = useLang();
  const [models] = useLoad<{ models: string[]; error?: string }>(`${BASE}/models`);
  const [draft, setDraft] = useState<ProjectDraft>({
    topic: "",
    language: "vi",
    duration: "30",
    mode: "image",
    chat_model: null,
    image_model: null,
    video_model: null,
    tts_model: null,
    voice: "alloy",
    image_size: IMAGE_SIZES[0]!,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof ProjectDraft, StringKey>>>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = models.status === "ready" ? models.data.models.map((m) => ({ value: m, label: m })) : [];
  const set = <K extends keyof ProjectDraft>(k: K, v: ProjectDraft[K]) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    if (tried) setErrors(validateProject(next));
  };
  const modelBox = (k: "chat_model" | "image_model" | "video_model" | "tts_model", label: StringKey, optional = false) => (
    <div>
      <Combobox
        label={t(label) + (optional ? ` (${t("clips.optional")})` : "")}
        options={options}
        value={draft[k]}
        onChange={(v) => set(k, v)}
        onCreate={(text) => set(k, text.trim())}
        invalid={!!errors[k]}
        aria-describedby={errors[k] ? `clips-${k}-err` : undefined}
        labels={ui(lang).combobox}
      />
      {errors[k] && (
        <small id={`clips-${k}-err`} className="clips-field-error" role="alert">
          {t(errors[k]!)}
        </small>
      )}
    </div>
  );

  async function submit() {
    setTried(true);
    const e = validateProject(draft);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ project: { id: string } }>(`${BASE}/projects`, { body: projectBody(draft) });
      onCreated(r.project.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog title={t("clips.newTitle")} submitLabel={t("clips.create")} labels={ui(lang).formDialog} busy={busy} error={error ?? undefined} onCancel={onCancel} onSubmit={() => void submit()}>
      {models.status === "ready" && models.data.error && <Banner tone="warn" title={t("clips.modelsError")}>{models.data.error}</Banner>}
      <Textarea label={t("clips.topic")} placeholder={t("clips.topicPlaceholder")} rows={2} value={draft.topic} error={errors.topic ? t(errors.topic) : undefined} onChange={(e) => set("topic", e.target.value)} />
      <div className="clips-row">
        <Select label={t("clips.language")} value={draft.language} onChange={(e) => set("language", e.target.value as "vi" | "en")} options={[{ value: "vi", label: "Tiếng Việt" }, { value: "en", label: "English" }]} />
        <Field label={t("clips.duration")} type="number" min={10} max={180} value={draft.duration} error={errors.duration ? t(errors.duration) : undefined} onChange={(e) => set("duration", e.target.value)} />
      </div>
      <div>
        <span className="clips-label" id="clips-mode-label">
          {t("clips.mode")}
        </span>
        <Segmented
          label={t("clips.mode")}
          value={draft.mode}
          onChange={(v) => set("mode", v as Mode)}
          options={(["image", "mixed", "video"] as const).map((m) => ({ value: m, label: t(`clips.mode.${m}` as StringKey) }))}
        />
      </div>
      {modelBox("chat_model", "clips.chatModel")}
      {modelBox("image_model", "clips.imageModel", draft.mode === "video")}
      {draft.mode !== "image" && modelBox("video_model", "clips.videoModel")}
      <div className="clips-row">
        {modelBox("tts_model", "clips.ttsModel", true)}
        <Field label={t("clips.voice")} value={draft.voice} onChange={(e) => set("voice", e.target.value)} />
      </div>
      <Select label={t("clips.imageSize")} value={draft.image_size} onChange={(e) => set("image_size", e.target.value)} options={IMAGE_SIZES.map((s) => ({ value: s, label: s }))} />
    </FormDialog>
  );
}

function ProjectView({ id }: { id: string }) {
  const [lang] = useLang();
  const notify = useNotify();
  const [detail, reload] = useLoad<ProjectDetail>(`${BASE}/projects/${id}`);
  const [channels] = useLoad<{ channels: Channel[] }>(`${BASE}/channels`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [when, setWhen] = useState("");
  const p = detail.status === "ready" ? detail.data.project : null;
  const live = !!p && (p.status === "running" || p.status === "queued");
  const pubLive = detail.status === "ready" && detail.data.publications.some((x) => x.status === "pending" || x.status === "running");

  useEffect(() => {
    if (!live && !pubLive) return;
    const h = setInterval(reload, 3000);
    return () => clearInterval(h);
  }, [live, pubLive, reload]);

  async function act(run: () => Promise<unknown>, done?: StringKey) {
    setBusy(true);
    setError(null);
    try {
      await run();
      if (done) notify(t(done));
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (detail.status === "loading") return <Skeleton lines={6} announce labels={{ loading: t("loading") }} />;
  if (detail.status === "error")
    return (
      <Stack gap={3}>
        <Button variant="link" icon="arrow-left" href="#/clips">
          {t("clips.back")}
        </Button>
        <Banner tone="danger" title={detail.code === "404" || detail.code === "not found" ? t("clips.notFound") : t("error.load")} />
      </Stack>
    );
  const { project, final, publications } = detail.data;
  const chans = channels.status === "ready" ? channels.data.channels : [];
  const chanName = (cid: string) => chans.find((c) => c.id === cid)?.name ?? cid;

  return (
    <Stack gap={4}>
      <Button variant="link" icon="arrow-left" href="#/clips">
        {t("clips.back")}
      </Button>
      <Card
        title={project.plan?.title ?? project.topic}
        subtitle={project.plan ? project.topic : undefined}
        headingLevel={2}
        actions={
          <div className="clips-actions">
            <StatusDot tone={STATUS_TONE[project.status]} pulse={live} label={project.status === "done" ? t(STATUS_LABEL.done) : `${t(STATUS_LABEL[project.status])} · ${t(STEP_LABEL[project.step])}`} />
            <Button size="sm" icon="refresh" disabled={busy || live} onClick={() => void act(() => api(`${BASE}/projects/${id}/retry`, { body: {} }), "clips.retried")}>
              {project.status === "done" ? t("clips.rerender") : t("clips.retry")}
            </Button>
            <IconButton icon="trash" tone="danger" label={t("clips.delete")} disabled={busy || live} onClick={() => setDeleting(true)} />
          </div>
        }
      >
        <Stack gap={3}>
          {project.error && <Banner tone="danger" title={t("clips.failed")}>{project.error}</Banner>}
          {error && <Banner tone="danger" title={error} />}
          <p className="muted clips-meta">
            {t(`clips.mode.${project.mode}` as StringKey)} · {project.duration}s · {project.chat_model} · {project.image_model}
            {project.video_model ? ` · ${project.video_model}` : ""}
            {project.tts_model ? ` · ${project.tts_model} (${project.voice})` : ""}
          </p>
          {project.plan?.description && <p>{project.plan.description}</p>}
          {project.plan?.hashtags.length ? <p className="muted">{project.plan.hashtags.map((h) => `#${h}`).join(" ")}</p> : null}
        </Stack>
      </Card>

      {final && (
        <Card title={t("clips.final")} headingLevel={2} actions={<Button size="sm" icon="download" href={fileUrl(id, "final.mp4")} download={`${id}.mp4`}>{t("clips.download")}</Button>}>
          <video className="clips-final" src={fileUrl(id, "final.mp4")} poster={fileUrl(id, "cover.jpg")} controls preload="metadata" />
        </Card>
      )}

      <Card title={t("clips.scenes")} headingLevel={2}>
        {!project.plan ? (
          <p className="muted">{live ? t("clips.writing") : t("clips.noPlan")}</p>
        ) : (
          <ol className="clips-scenes">
            {project.plan.scenes.map((s, i) => (
              <li key={i} className="clips-scene">
                <div className="clips-scene-media">
                  {s.video ? (
                    <video src={fileUrl(id, s.video)} muted loop controls preload="metadata" aria-label={s.visual} />
                  ) : s.image ? (
                    <img src={fileUrl(id, s.image)} alt={s.visual} loading="lazy" />
                  ) : (
                    <span className="muted">{live ? t("clips.making") : "—"}</span>
                  )}
                </div>
                <div className="clips-scene-text">
                  <strong>
                    {t("clips.scene", { n: String(i + 1) })} · {s.kind === "video" ? t("clips.mode.video") : t("clips.mode.image")}
                    {s.duration ? ` · ${s.duration.toFixed(1)}s` : ""}
                  </strong>
                  <p>{s.narration}</p>
                  <p className="muted">{s.visual}</p>
                  {s.note && <p className="clips-note">{s.note}</p>}
                  {s.audio && <audio src={fileUrl(id, s.audio)} controls preload="none" aria-label={t("clips.voiceOf", { n: String(i + 1) })} />}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={t("clips.publish")} headingLevel={2}>
        <Stack gap={3}>
          {project.step !== "done" ? (
            <p className="muted">{t("clips.publishAfter")}</p>
          ) : chans.length === 0 ? (
            <EmptyState size="inline" icon="send" title={t("clips.noChannels")} actions={<Button href="#/clips/channels">{t("clips.addChannel")}</Button>} />
          ) : (
            <form
              className="clips-publish"
              onSubmit={(e) => {
                e.preventDefault();
                const at = when ? new Date(when).getTime() : undefined;
                void act(() => api(`${BASE}/projects/${id}/publish`, { body: { channels: [...picked], ...(at ? { at } : {}) } }), at ? "clips.scheduled" : "clips.publishing").then(() => setPicked(new Set()));
              }}
            >
              <fieldset className="clips-channels">
                <legend>{t("clips.pickChannels")}</legend>
                {chans.map((c) => (
                  <Checkbox
                    key={c.id}
                    label={`${c.name} (${c.kind})`}
                    checked={picked.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setPicked(next);
                    }}
                  />
                ))}
              </fieldset>
              <Field label={t("clips.when")} hint={t("clips.whenHint")} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              <div>
                <Button type="submit" variant="primary" icon="send" disabled={busy || picked.size === 0}>
                  {when ? t("clips.schedule") : t("clips.publishNow")}
                </Button>
              </div>
            </form>
          )}
          {publications.length > 0 && (
            <ul className="clips-pubs" aria-label={t("clips.publications")}>
              {publications.map((x) => (
                <li key={x.id} className="clips-pub">
                  <StatusDot tone={STATUS_TONE[x.status]} pulse={x.status === "running"} label={t(STATUS_LABEL[x.status])} />
                  <span>{chanName(x.channel_id)}</span>
                  <span className="muted">{new Date(x.scheduled_at).toLocaleString()}</span>
                  {x.url && (
                    <Button variant="link" size="sm" icon="external" href={x.url} target="_blank" rel="noreferrer noopener">
                      {t("clips.open")}
                    </Button>
                  )}
                  {x.error && <span className="clips-note">{x.error}</span>}
                  {x.status === "failed" && (
                    <Button size="sm" disabled={busy} onClick={() => void act(() => api(`${BASE}/publications/${x.id}/retry`, { method: "POST" }), "clips.retried")}>
                      {t("clips.retry")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </Card>

      {deleting && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("clips.deleteTitle")}
          confirmLabel={t("clips.delete")}
          busy={busy}
          labels={ui(lang).dialog}
          onCancel={() => setDeleting(false)}
          onConfirm={() =>
            void act(async () => {
              await api(`${BASE}/projects/${id}`, { method: "DELETE" });
              window.location.hash = "#/clips";
            }, "clips.deleted")
          }
        >
          {t("clips.deleteBody")}
        </Dialog>
      )}
    </Stack>
  );
}

function ChannelsPanel({ canStore }: { canStore: boolean }) {
  const [lang] = useLang();
  const notify = useNotify();
  const [kinds] = useLoad<{ kinds: ChannelKind[]; canStore: boolean }>(`${BASE}/channel-kinds`);
  const [list, reload] = useLoad<{ channels: Channel[] }>(`${BASE}/channels`);
  const [adding, setAdding] = useState<ChannelKind | null>(null);
  const [removing, setRemoving] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);
  const kindName = (k: string) => (kinds.status === "ready" ? (kinds.data.kinds.find((x) => x.kind === k)?.name ?? k) : k);

  const columns: DataTableColumn<Channel>[] = [
    { key: "name", header: t("clips.channel.name"), cell: (c) => c.name },
    { key: "kind", header: t("clips.channel.kind"), cell: (c) => kindName(c.kind) },
    { key: "created", header: t("clips.col.created"), width: "min", hideNarrow: true, cell: (c) => new Date(c.created_at).toLocaleDateString() },
    { key: "actions", header: "", width: "min", sticky: "end", cell: (c) => <IconButton icon="trash" tone="danger" label={t("clips.channel.remove", { name: c.name })} onClick={() => setRemoving(c)} /> },
  ];

  return (
    <Stack gap={4}>
      {!canStore && <Banner tone="warn" title={t("clips.noKey")} />}
      <Card
        title={t("clips.channels")}
        headingLevel={2}
        actions={
          kinds.status === "ready" ? (
            <Select
              aria-label={t("clips.channel.add")}
              value=""
              disabled={!canStore}
              onChange={(e) => setAdding(kinds.data.kinds.find((k) => k.kind === e.target.value) ?? null)}
              options={[{ value: "", label: t("clips.channel.add") }, ...kinds.data.kinds.map((k) => ({ value: k.kind, label: k.name }))]}
            />
          ) : undefined
        }
      >
        {list.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
        {list.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
        {list.status === "ready" && (
          <DataTable
            caption={t("clips.channels")}
            columns={columns}
            rows={list.data.channels}
            rowKey={(c) => c.id}
            rowLabel={(c) => c.name}
            labels={ui(lang).dataTable}
            empty={<EmptyState size="inline" icon="send" title={t("clips.noChannels")} hint={t("clips.noChannelsHint")} />}
          />
        )}
      </Card>
      {adding && (
        <ChannelDialog
          kind={adding}
          onCancel={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            notify(t("clips.channel.added"));
            reload();
          }}
        />
      )}
      {removing && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("clips.channel.removeTitle", { name: removing.name })}
          confirmLabel={t("clips.channel.removeConfirm")}
          busy={busy}
          labels={ui(lang).dialog}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api(`${BASE}/channels/${removing.id}`, { method: "DELETE" });
              notify(t("clips.channel.removed"));
            } catch {
              notify(t("error.generic"));
            } finally {
              setBusy(false);
              setRemoving(null);
              reload();
            }
          }}
        >
          {t("clips.channel.removeBody")}
        </Dialog>
      )}
    </Stack>
  );
}

function ChannelDialog({ kind, onCancel, onSaved }: { kind: ChannelKind; onCancel: () => void; onSaved: () => void }) {
  const [lang] = useLang();
  const [name, setName] = useState(kind.name);
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = [...kind.secretFields.filter((f) => !f.optional && !secret[f.key]?.trim()), ...kind.configFields.filter((f) => !f.optional && !config[f.key]?.trim())];

  async function submit() {
    if (missing.length) {
      setError(t("clips.channel.missing", { fields: missing.map((f) => f.label).join(", ") }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`${BASE}/channels`, { body: { kind: kind.kind, name: name.trim(), secret, config } });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog title={t("clips.channel.addTitle", { kind: kind.name })} submitLabel={t("common.save")} labels={ui(lang).formDialog} busy={busy} error={error ?? undefined} onCancel={onCancel} onSubmit={() => void submit()}>
      <Field label={t("clips.channel.name")} value={name} onChange={(e) => setName(e.target.value)} />
      {kind.secretFields.map((f) => (
        <Field
          key={f.key}
          label={f.label + (f.optional ? ` (${t("clips.optional")})` : "")}
          hint={f.help}
          type="password"
          autoComplete="off"
          labels={ui(lang).field}
          value={secret[f.key] ?? ""}
          onChange={(e) => setSecret({ ...secret, [f.key]: e.target.value })}
        />
      ))}
      {kind.configFields.map((f) => (
        <Field key={f.key} label={f.label + (f.optional ? ` (${t("clips.optional")})` : "")} hint={f.help} value={config[f.key] ?? ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
      ))}
      <p className="muted">{t("clips.channel.sealed")}</p>
    </FormDialog>
  );
}
