import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  Dialog,
  Emblem,
  EmptyState,
  Field,
  FormDialog,
  Grid,
  IconButton,
  ListRow,
  ResourceCard,
  Skeleton,
  SortableList,
  Stack,
  StatusDot,
  Tabs,
  moveItem,
} from "@xdev-asia/ui";
import { ApiError, api, useLoad, type Connection, type Provider } from "../api";
import { t, useLang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { providerLogo } from "../provider-logos";
import { ui } from "../ui-labels";

export const MEDIA_TABS = ["embeddings", "images", "video", "speech", "transcription", "web"] as const;
export type MediaTab = (typeof MEDIA_TABS)[number];
export type MediaKind = Exclude<MediaTab, "web">;

/** The tab a `#/media/<tab>` hash names; embeddings for none or an unknown one. */
export const mediaTab = (tab: string | null): MediaTab => ((MEDIA_TABS as readonly string[]).includes(tab ?? "") ? (tab as MediaTab) : "embeddings");

/** A provider with its own API (worker/media-providers/registry.ts): the gateway turns the OpenAI request into its call. The key never reaches the console. */
export interface MediaApiProvider {
  id: string;
  name: string;
  color: string;
  mark: string;
  alias: string | null;
  key_url: string;
  /** "aws": ACCESS_KEY_ID:SECRET[:REGION]; "playht": USER_ID:API_KEY; "plain": the key as given. */
  key_format: "plain" | "aws" | "playht";
  kinds: string[];
  models: Record<string, string[]>;
  connections: number;
  env_key: boolean;
  configured: boolean;
}

export type UnsupportedReason = "scrapes" | "no_api" | "local" | "custom" | "no_auth" | "placeholder";

/** GET /admin/media (worker/media.ts). */
interface MediaInfo {
  kinds: { kind: string; path: string; body: "json" | "multipart" }[];
  providers: string[];
  media_providers?: MediaApiProvider[];
  /** Media providers this gateway does not offer, with why. */
  unsupported?: { id: string; name: string; reason: UnsupportedReason }[];
}

/** The key's shape, checked as worker/media-providers/registry.ts checks it (the gateway checks it again). */
export function mediaKeyOk(format: MediaApiProvider["key_format"], raw: string): boolean {
  const key = raw.trim();
  if (!key || key.length > 4096) return false;
  if (format === "playht") return /^[^:\s]+:[^:\s]+$/.test(key);
  if (format === "aws") {
    const [id, secret, region = "us-east-1", ...more] = key.split(":");
    return !more.length && /^[A-Z0-9]{16,128}$/.test(id) && !!secret && secret.length >= 16 && !/\s/.test(secret) && /^[a-z0-9-]{4,30}$/.test(region);
  }
  return !/\s/.test(key);
}

const KEY_HINT: Record<MediaApiProvider["key_format"], StringKey> = {
  plain: "media.keyHint",
  aws: "media.keyHintAws",
  playht: "media.keyHintPlayht",
};

const REASON: Record<UnsupportedReason, StringKey> = {
  scrapes: "media.reason.scrapes",
  no_api: "media.reason.noApi",
  local: "media.reason.local",
  custom: "media.reason.custom",
  no_auth: "media.reason.noAuth",
  placeholder: "media.reason.placeholder",
};

/** One web search or fetch provider (GET /admin/web-tools). The key itself never reaches the console. */
export interface WebTool {
  id: string;
  name: string;
  kind: "search" | "fetch";
  key_url: string;
  keyless: boolean;
  /** Needs a Cloudflare account id beside the key (Browser Rendering); it is sealed with the key and never answered. */
  needs_account?: boolean;
  /** The setting asked for beside the key ("account_id", "cx"), or "base_url" for a self-hosted instance with no key. */
  needs?: "account_id" | "cx" | "base_url" | null;
  /** False when the tool takes no key at all (SearXNG). */
  needs_key?: boolean;
  configured: boolean;
  hint: string | null;
  updated_at: number | null;
}

export interface WebTools {
  search: WebTool[];
  fetch: WebTool[];
  order: { search: string[]; fetch: string[] };
}

type TestResult = { ok: boolean; ms?: number; status?: number; message?: string };

/** Never a real token: the reader puts their own in. */
export const TOKEN_PLACEHOLDER = "<your gateway token>";

const PATHS: Record<MediaKind, string> = {
  embeddings: "/v1/embeddings",
  images: "/v1/images/generations",
  video: "/v1/videos",
  speech: "/v1/audio/speech",
  transcription: "/v1/audio/transcriptions",
};

/** A request body for each kind, with a model such as a client would send (`<provider>/<model>`). */
const BODIES: Record<Exclude<MediaKind, "transcription">, Record<string, unknown>> = {
  embeddings: { model: "openai/text-embedding-3-small", input: "The quick brown fox" },
  images: { model: "openai/gpt-image-1", prompt: "A lighthouse at dusk", size: "1024x1024" },
  video: { model: "openai/sora-2", prompt: "Waves on a beach at sunrise", seconds: "4" },
  speech: { model: "openai/gpt-4o-mini-tts", input: "Hello from the gateway", voice: "alloy" },
};

/** A curl call to one media endpoint of this gateway. */
export function mediaExample(kind: MediaKind, origin: string, path: string = PATHS[kind]): string {
  const url = `${origin.replace(/\/+$/, "")}${path}`;
  const auth = `  -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
  if (kind === "transcription") return [`curl ${url} \\`, `${auth} \\`, "  -F model=openai/whisper-1 \\", "  -F file=@audio.mp3"].join("\n");
  const lines = [`curl ${url} \\`, `${auth} \\`, '  -H "Content-Type: application/json" \\', `  -d '${JSON.stringify(BODIES[kind])}'`];
  if (kind === "speech") lines[lines.length - 1] += " \\\n  --output speech.mp3";
  return lines.join("\n");
}

/** A curl call to /v1/search or /v1/fetch. */
export function webExample(kind: "search" | "fetch", origin: string): string {
  const body = kind === "search" ? { query: "cloudflare workers d1", n: 5 } : { url: "https://example.com/" };
  return [`curl ${origin.replace(/\/+$/, "")}/v1/${kind} \\`, `  -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" \\`, '  -H "Content-Type: application/json" \\', `  -d '${JSON.stringify(body)}'`].join("\n");
}

const TAB_LABEL: Record<MediaTab, StringKey> = {
  embeddings: "media.tab.embeddings",
  images: "media.tab.images",
  video: "media.tab.video",
  speech: "media.tab.speech",
  transcription: "media.tab.transcription",
  web: "media.tab.web",
};

const ABOUT: Record<MediaKind, StringKey> = {
  embeddings: "media.about.embeddings",
  images: "media.about.images",
  video: "media.about.video",
  speech: "media.about.speech",
  transcription: "media.about.transcription",
};

/**
 * Media providers: one tab per kind of request. A media tab shows the endpoint
 * with a call to copy and the providers with an account that can serve it; the last tab holds web search and
 * fetch. The tab lives in the hash (`#/media/<tab>`).
 */
export function Media({ tab }: { tab: string | null }) {
  useLang();
  const current = mediaTab(tab);
  return (
    <Stack gap={4}>
      <Tabs
        label={t("media.tabs")}
        idPrefix="media"
        value={current}
        onChange={(id) => {
          window.location.hash = `#/media/${id}`;
        }}
        items={MEDIA_TABS.map((id) => ({ id, label: t(TAB_LABEL[id]) }))}
      />
      <div role="tabpanel" id={`media-panel-${current}`} aria-labelledby={`media-tab-${current}`}>
        {current === "web" ? <WebToolsPanel /> : <MediaKindPanel key={current} kind={current} />}
      </div>
    </Stack>
  );
}

/** What a provider has, under its name on a media card. */
function MediaProviderStatus({ provider, accounts }: { provider: Provider; accounts: Connection[] }) {
  const on = accounts.filter((a) => !a.disabled).length;
  if (on > 0) return <StatusDot tone="ok" label={t("media.connected", { n: String(on) })} />;
  if (provider.env_key) return <StatusDot tone="ok" label={t("media.envKey")} />;
  return <StatusDot tone="neutral" label={t("media.allOff")} />;
}

function MediaKindPanel({ kind }: { kind: MediaKind }) {
  const [lang] = useLang();
  const [media, reloadMedia] = useLoad<MediaInfo>("/media");
  const [providers, reloadProviders] = useLoad<Provider[]>("/providers");
  const [connections, reloadConnections] = useLoad<Connection[]>("/connections");
  const reload = () => {
    reloadMedia();
    reloadProviders();
    reloadConnections();
  };
  const states = [media.status, providers.status, connections.status];
  const ready = media.status === "ready" && providers.status === "ready" && connections.status === "ready";
  const path = (media.status === "ready" ? media.data.kinds.find((k) => k.kind === kind)?.path : undefined) ?? PATHS[kind];

  const usable = ready
    ? providers.data
        .filter((p) => media.data.providers.includes(p.id))
        .map((p) => ({ provider: p, accounts: connections.data.filter((c) => c.provider === p.id) }))
        .filter(({ provider, accounts }) => accounts.length > 0 || provider.env_key)
    : [];
  const apiProviders = ready ? (media.data.media_providers ?? []).filter((p) => p.kinds.includes(kind)) : [];
  const unsupported = ready ? (media.data.unsupported ?? []) : [];
  const notify = useNotify();
  const [adding, setAdding] = useState<MediaApiProvider | null>(null);
  const [removing, setRemoving] = useState<MediaApiProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const keysOf = (p: MediaApiProvider) => (connections.status === "ready" ? connections.data.filter((c) => c.provider === p.id) : []);

  /** Removes every stored key of one provider, one DELETE each; a key already gone counts as removed. */
  async function removeKeys(p: MediaApiProvider) {
    setBusy(true);
    setRemoveError(null);
    try {
      for (const k of keysOf(p)) {
        try {
          await api(`/connections/${encodeURIComponent(k.id)}`, { method: "DELETE" });
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
      }
      notify(t("media.keysRemoved", { name: p.name }));
      setRemoving(null);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setRemoveError(t("error.generic"));
      setRemoving(null);
    } finally {
      setBusy(false);
      reload();
    }
  }

  return (
    <Stack gap={4}>
      <Card title={t("media.endpoint")} subtitle={`POST ${path}`} monoSubtitle headingLevel={2}>
        <Stack gap={3}>
          <p className="muted">{t(ABOUT[kind])}</p>
          <CodeBlock language="bash" code={mediaExample(kind, window.location.origin, path)} labels={ui(lang).codeBlock} />
        </Stack>
      </Card>
      <section className="providers-section" aria-labelledby="media-providers">
        <div className="providers-section-head">
          <h2 className="providers-section-title" id="media-providers">
            {t("media.providers")}
          </h2>
          {ready && <span className="providers-section-count">{usable.length}</span>}
        </div>
        {states.includes("loading") && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
        {states.includes("error") && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
        {ready && usable.length === 0 && apiProviders.length === 0 && (
          <EmptyState
            icon="plug"
            size="center"
            title={t("media.none")}
            hint={t("media.noneHint")}
            actions={
              <Button href="#/providers" icon="plus">
                {t("media.addConnection")}
              </Button>
            }
          />
        )}
        {usable.length > 0 && (
          <Grid minItemWidth="15rem" gap={3}>
            {usable.map(({ provider, accounts }) => (
              <ResourceCard
                key={provider.id}
                href={`#/providers/${provider.id}`}
                leading={<Emblem name={provider.name} text={provider.mark} color={provider.color} src={providerLogo(provider.id)} />}
                title={provider.name}
                status={<MediaProviderStatus provider={provider} accounts={accounts} />}
                dimmed={!provider.env_key && accounts.every((a) => a.disabled)}
              />
            ))}
          </Grid>
        )}
        {ready && usable.length === 0 && apiProviders.length > 0 && <p className="muted">{t("media.noneOpenAI")}</p>}
      </section>
      {apiProviders.length > 0 && (
        <section className="providers-section" aria-labelledby="media-api-providers">
          <div className="providers-section-head">
            <h2 className="providers-section-title" id="media-api-providers">
              {t("media.apiProviders")}
            </h2>
            <span className="providers-section-count">{apiProviders.filter((p) => p.configured).length}</span>
          </div>
          <p className="muted">{t("media.apiProvidersHint")}</p>
          {removeError && <Banner tone="danger" title={removeError} />}
          <Grid minItemWidth="15rem" gap={3}>
            {apiProviders.map((p) => (
              <ResourceCard
                key={p.id}
                onClick={() => setAdding(p)}
                leading={<Emblem name={p.name} text={p.mark} color={p.color} src={providerLogo(p.id)} />}
                title={p.name}
                status={
                  p.connections > 0 ? (
                    <StatusDot tone="ok" label={t("media.connected", { n: String(p.connections) })} />
                  ) : p.env_key ? (
                    <StatusDot tone="ok" label={t("media.envKey")} />
                  ) : (
                    <StatusDot tone="neutral" label={t("media.noKey")} />
                  )
                }
                dimmed={!p.configured}
                trailing={
                  <>
                    <Button variant="link" size="sm" icon="external" href={p.key_url} target="_blank" rel="noreferrer noopener" aria-label={t("media.getKeyAt", { name: p.name })}>
                      {t("media.getKey")}
                    </Button>
                    {keysOf(p).length > 0 && <IconButton icon="trash" size="sm" label={t("media.removeKeysName", { name: p.name })} disabled={busy} onClick={() => setRemoving(p)} />}
                  </>
                }
              />
            ))}
          </Grid>
          {unsupported.length > 0 && (
            <p className="muted">
              {t("media.unsupported", { list: unsupported.map((u) => `${u.name} (${t(REASON[u.reason])})`).join("; ") })}
            </p>
          )}
        </section>
      )}
      {removing && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("media.removeKeysTitle", { name: removing.name })}
          labels={ui(lang).dialog}
          confirmLabel={t("media.removeKeys")}
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void removeKeys(removing)}
        >
          <Stack gap={2}>
            <p>{t("media.removeKeysBody")}</p>
            <ul>
              {keysOf(removing).map((k) => (
                <li key={k.id}>{k.hint ? t("media.keyLine", { name: k.name, hint: k.hint }) : k.name}</li>
              ))}
            </ul>
          </Stack>
        </Dialog>
      )}
      {adding && (
        <MediaKeyDialog
          provider={adding}
          kind={kind}
          onCancel={() => setAdding(null)}
          onSaved={() => {
            notify(t("media.keySaved", { name: adding.name }));
            setAdding(null);
            reload();
          }}
        />
      )}
    </Stack>
  );
}

/** Adds a key for a provider with its own API (POST /admin/media/connections). The key is sent once and never read back. */
function MediaKeyDialog({ provider, kind, onCancel, onSaved }: { provider: MediaApiProvider; kind: MediaKind; onCancel: () => void; onSaved: () => void }) {
  const [lang] = useLang();
  const [name, setName] = useState(provider.name);
  const [apiKey, setApiKey] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = name.trim().length >= 1 && name.trim().length <= 100;
  const keyOk = mediaKeyOk(provider.key_format, apiKey);
  const models = provider.models[kind] ?? [];

  async function submit() {
    setTried(true);
    if (!nameOk || !keyOk) return;
    setBusy(true);
    setError(null);
    try {
      await api("/media/connections", { method: "POST", body: { provider: provider.id, name: name.trim(), api_key: apiKey.trim() } });
      setApiKey("");
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.code === "not_configured" ? t("media.notConfigured") : e instanceof ApiError && e.code === "invalid_input" ? t("media.apiKeyBad") : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={t("media.addKeyTitle", { name: provider.name })}
      description={models.length ? t("media.models", { models: models.map((m) => `${provider.id}/${m}`).join(", ") }) : undefined}
      submitLabel={t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field label={t("media.keyName")} value={name} maxLength={100} autoComplete="off" onChange={(e) => setName(e.target.value)} error={tried && !nameOk ? t("media.keyNameBad") : undefined} />
      <Field
        label={t("media.apiKey")}
        hint={t(KEY_HINT[provider.key_format])}
        type="password"
        value={apiKey}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setApiKey(e.target.value)}
        error={tried && !keyOk ? t("media.apiKeyBad") : undefined}
      />
      <div>
        <Button variant="link" size="sm" icon="external" href={provider.key_url} target="_blank" rel="noreferrer noopener">
          {t("media.getKeyAt", { name: provider.name })}
        </Button>
      </div>
    </FormDialog>
  );
}

type Pending = { kind: "key"; tool: WebTool } | { kind: "remove"; tool: WebTool } | null;

const usableTool = (tool: WebTool) => tool.configured || tool.keyless;

/** Web search and fetch: one card per kind, its providers in the order the gateway tries them. */
function WebToolsPanel() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [tools, reload] = useLoad<WebTools>("/web-tools");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});
  /** The order just chosen, shown until the gateway's answer replaces it. */
  const [order, setOrder] = useState<{ search: string[]; fetch: string[] } | null>(null);

  const loaded = tools.status === "ready" ? tools.data : null;
  useEffect(() => setOrder(null), [loaded]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const listOf = (kind: "search" | "fetch"): WebTool[] => {
    const list = loaded?.[kind] ?? [];
    const ids = order?.[kind];
    return ids ? [...list].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) : list;
  };

  const reorder = (kind: "search" | "fetch", from: number, to: number) => {
    const next = {
      search: listOf("search").map((x) => x.id),
      fetch: listOf("fetch").map((x) => x.id),
    };
    next[kind] = moveItem(listOf(kind), from, to).map((x) => x.id);
    setOrder(next);
    void run(async () => {
      try {
        await api("/web-tools/order", { method: "PUT", body: next });
      } finally {
        reload();
      }
    });
  };

  const test = async (tool: WebTool) => {
    setTests((m) => ({ ...m, [tool.id]: "running" }));
    try {
      const r = await api<TestResult>(`/web-tools/${encodeURIComponent(tool.id)}/test`, { method: "POST" });
      setTests((m) => ({ ...m, [tool.id]: r }));
    } catch (e) {
      setTests((m) => ({ ...m, [tool.id]: { ok: false, message: e instanceof ApiError ? e.code : "failed" } }));
    }
  };

  const remove = (tool: WebTool) =>
    run(async () => {
      await api(`/web-tools/${encodeURIComponent(tool.id)}`, { method: "DELETE" });
      notify(t("web.removed", { name: tool.name }));
      setTests((m) => {
        const { [tool.id]: _gone, ...rest } = m;
        return rest;
      });
      setPending(null);
      reload();
    });

  const meta = (tool: WebTool) => {
    const r = tests[tool.id];
    const key =
      tool.configured && tool.hint
        ? tool.needs_key === false
          ? t("web.instanceHint", { host: tool.hint })
          : t("web.keyHint", { hint: tool.hint })
        : tool.keyless
          ? t("web.keyless")
          : tool.needs_key === false
            ? t("web.noInstance")
            : t("web.noKey");
    const result =
      r === undefined
        ? null
        : r === "running"
          ? t("web.testing")
          : r.ok
            ? t("web.testOk", { ms: String(r.ms ?? 0) })
            : t("web.testFailed", { error: [r.status ? String(r.status) : "", r.message ?? ""].join(" ").trim() || t("error.generic") });
    return (
      <>
        <span className="account-meta-line">{key}</span>
        {result && <span className="account-meta-line">{result}</span>}
      </>
    );
  };

  const status = (tool: WebTool) => {
    const r = tests[tool.id];
    if (r !== undefined && r !== "running" && !r.ok) return <StatusDot tone="danger" label={t("web.status.failed")} />;
    if (usableTool(tool)) return <StatusDot tone="ok" label={t("web.status.ready")} />;
    return <StatusDot tone="neutral" label={t("web.status.off")} />;
  };

  const card = (kind: "search" | "fetch") => {
    const list = listOf(kind);
    return (
      <Card title={t(kind === "search" ? "web.search" : "web.fetch")} subtitle={t("web.orderHint")} headingLevel={2} flush>
        <SortableList
          items={list}
          getKey={(x) => x.id}
          getLabel={(x) => x.name}
          label={t(kind === "search" ? "web.search" : "web.fetch")}
          labels={{ ...labels.sortableList, handle: (name) => t("web.move", { name }) }}
          disabled={busy}
          onReorder={(from, to) => reorder(kind, from, to)}
          renderItem={(tool, _index, handle) => (
            <ListRow
              className="account-row"
              leading={
                <>
                  {handle}
                  <Emblem name={tool.name} text={MARKS[tool.id]} />
                </>
              }
              title={tool.name}
              meta={meta(tool)}
              trailing={
                <>
                  {status(tool)}
                  {!tool.configured && (
                    <Button variant="link" size="sm" icon="external" href={tool.key_url} target="_blank" rel="noreferrer noopener" aria-label={t("web.getKeyAt", { name: tool.name })}>
                      {t("web.getKey")}
                    </Button>
                  )}
                  <Button size="sm" disabled={busy || !usableTool(tool) || tests[tool.id] === "running"} onClick={() => void test(tool)} aria-label={t("web.testName", { name: tool.name })}>
                    {t("web.test")}
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => setPending({ kind: "key", tool })} aria-label={t(tool.configured ? "web.replaceKeyName" : "web.setKeyName", { name: tool.name })}>
                    {t(tool.configured ? "web.replaceKey" : "web.setKey")}
                  </Button>
                  {tool.configured && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending({ kind: "remove", tool })} aria-label={t("web.removeName", { name: tool.name })}>
                      {t("web.remove")}
                    </Button>
                  )}
                </>
              }
            />
          )}
        />
      </Card>
    );
  };

  return (
    <Stack gap={4}>
      <Card title={t("web.endpoints")} headingLevel={2}>
        <Stack gap={3}>
          <p className="muted">{t("web.about")}</p>
          <CodeBlock language="bash" code={webExample("search", window.location.origin)} labels={labels.codeBlock} />
          <CodeBlock language="bash" code={webExample("fetch", window.location.origin)} labels={labels.codeBlock} />
        </Stack>
      </Card>
      {error && <Banner tone="danger" title={error} />}
      {tools.status === "loading" && <Skeleton lines={4} announce labels={{ loading: t("loading") }} />}
      {tools.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {/* One above the other: side by side, a row's buttons leave no room for the provider's name. */}
      {loaded && (
        <>
          {card("search")}
          {card("fetch")}
        </>
      )}
      {pending?.kind === "key" && (
        <WebKeyDialog
          tool={pending.tool}
          onCancel={() => setPending(null)}
          onSaved={() => {
            notify(t("web.keySaved", { name: pending.tool.name }));
            setTests((m) => {
              const { [pending.tool.id]: _old, ...rest } = m;
              return rest;
            });
            setPending(null);
            reload();
          }}
        />
      )}
      {pending?.kind === "remove" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("web.removeTitle", { name: pending.tool.name })}
          labels={labels.dialog}
          confirmLabel={t("web.remove")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void remove(pending.tool)}
        >
          {pending.tool.keyless ? t("web.removeBodyKeyless") : t("web.removeBody")}
        </Dialog>
      )}
    </Stack>
  );
}

/** One to three letters per web tool for its Emblem; the rest fall back to initials. */
const MARKS: Record<string, string> = {
  tavily: "Tv",
  brave: "Br",
  exa: "Ex",
  serper: "Sr",
  jina: "Ji",
  firecrawl: "Fc",
  cloudflare: "CF",
  "google-pse": "G",
  linkup: "Lu",
  searchapi: "SA",
  youcom: "You",
  perplexity: "Px",
  tinyfish: "TF",
  ollama: "Ol",
  searxng: "Sx",
  xquik: "X",
};

/** The setting a web tool asks for beside its key (or instead of one), checked as the gateway checks it. */
const EXTRA = {
  account_id: { label: "web.accountId", hint: "web.accountIdHint", bad: "web.accountIdBad", max: 32, norm: (v: string) => v.trim().toLowerCase(), ok: (v: string) => /^[0-9a-f]{32}$/.test(v) },
  cx: { label: "web.cx", hint: "web.cxHint", bad: "web.cxBad", max: 100, norm: (v: string) => v.trim(), ok: (v: string) => /^[A-Za-z0-9:_-]{5,100}$/.test(v) },
  base_url: {
    label: "web.baseUrl",
    hint: "web.baseUrlHint",
    bad: "web.baseUrlBad",
    max: 500,
    norm: (v: string) => v.trim(),
    ok: (v: string) => {
      try {
        const u = new URL(v);
        return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
      } catch {
        return false;
      }
    },
  },
} as const;
const extraOf = (tool: WebTool) => tool.needs ?? (tool.needs_account ? "account_id" : null);

/** Sets or replaces a web tool's key. The key is sent once and never read back. */
function WebKeyDialog({ tool, onCancel, onSaved }: { tool: WebTool; onCancel: () => void; onSaved: () => void }) {
  const [lang] = useLang();
  const [apiKey, setApiKey] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = apiKey.trim();
  const needsKey = tool.needs_key !== false;
  const ok = !needsKey || (value.length >= 8 && value.length <= 512 && !/\s/.test(value));
  const [accountId, setAccountId] = useState("");
  const needs = extraOf(tool);
  const spec = needs ? EXTRA[needs] : null;
  const account = spec ? spec.norm(accountId) : "";
  const accountOk = !spec || spec.ok(account);

  async function submit() {
    setTried(true);
    if (!ok || !accountOk) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = needsKey ? { api_key: value } : {};
      if (needs) body[needs] = account;
      await api(`/web-tools/${encodeURIComponent(tool.id)}`, { method: "PUT", body });
      setApiKey("");
      setAccountId("");
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.code === "not_configured" ? t("web.notConfigured") : e instanceof ApiError && e.code === "invalid_input" ? t("web.apiKeyBad") : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={t(tool.configured ? "web.replaceKeyTitle" : "web.setKeyTitle", { name: tool.name })}
      description={tool.keyless ? t("web.keylessNote") : undefined}
      submitLabel={t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      {spec && (
        <Field
          label={t(spec.label)}
          hint={t(spec.hint)}
          value={accountId}
          maxLength={spec.max}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setAccountId(e.target.value)}
          error={tried && !accountOk ? t(spec.bad) : undefined}
        />
      )}
      {needsKey && (
        <Field
          label={t("web.apiKey")}
          hint={tool.configured && tool.hint ? t("web.apiKeyReplaceHint", { hint: tool.hint }) : t("web.apiKeyHint")}
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setApiKey(e.target.value)}
          error={tried && !ok ? t("web.apiKeyBad") : undefined}
        />
      )}
      <div>
        <Button variant="link" size="sm" icon="external" href={tool.key_url} target="_blank" rel="noreferrer noopener">
          {t("web.getKeyAt", { name: tool.name })}
        </Button>
      </div>
    </FormDialog>
  );
}
