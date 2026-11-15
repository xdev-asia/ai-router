import { useState } from "react";
import { Badge, Banner, Button, Card, CodeBlock, Dialog, Emblem, EmptyState, Field, FormDialog, ListRow, Skeleton, Stack, StatusDot, Textarea } from "@xdev-asia/ui";
import { ApiError, api, useLoad } from "../api";
import { t, useLang } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";

/** One exit's check, as the last test left it. */
export interface RelayCheck {
  url: string;
  ok: boolean;
  ms: number;
  status?: number;
  /** Why a proxy could not be reached (never holds its password). */
  error?: string;
}

/** An HTTP or SOCKS5 proxy as the worker answers it: host and port only, and whether it has a user name and password. */
export interface PoolProxy {
  url: string;
  kind: "http" | "socks5";
  has_auth: boolean;
}

/**
 * GET /admin/proxy-pools (worker/proxy-pools.ts). Neither the relay secret nor a proxy's user name or password
 * reaches the console: only the secret's hint and `has_auth`.
 */
export interface ProxyPool {
  id: string;
  name: string;
  relays: string[];
  /** Missing from answers made before proxies were added. */
  proxies?: PoolProxy[];
  hint: string | null;
  last_check: RelayCheck[] | null;
  checked_at: number | null;
  connections: number;
  created_at: number;
  updated_at: number;
}

export const MAX_RELAYS = 10;
export const MIN_SECRET = 32;

/** Relay URLs typed one per line: trimmed, blank lines and repeats dropped. */
export function parseRelays(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim().replace(/\/+$/, "");
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** An http(s) base URL with no user, query or fragment, as the worker accepts. */
export function validRelay(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

const PROXY_SCHEMES = ["http:", "socks5:", "socks5h:"];

/** An exit as the worker accepts it: an https relay, or an http:// or socks5:// proxy with no path (port 25 is refused). */
export function validEntry(url: string): boolean {
  if (url.startsWith("https:")) return validRelay(url);
  try {
    const u = new URL(url);
    if (!PROXY_SCHEMES.includes(u.protocol) || !u.hostname || u.search || u.hash) return false;
    if (u.pathname !== "" && u.pathname !== "/") return false;
    return u.port !== "25" && Boolean(u.username) === Boolean(u.password);
  } catch {
    return false;
  }
}

/** Whether the typed list has a relay, which is what needs the pool secret. */
export const hasRelay = (entries: string[]) => entries.some((e) => e.startsWith("https:"));

/** Every exit of a pool as it is typed back into the dialog: relays, then proxies with no credential. */
export const entriesOf = (pool: ProxyPool) => [...pool.relays, ...(pool.proxies ?? []).map((p) => p.url)];

/** Every pool, and the active ones: those whose last test reached at least one exit. */
export function poolCounts(pools: ProxyPool[]): { total: number; active: number } {
  return { total: pools.length, active: pools.filter((p) => p.last_check?.some((c) => c.ok)).length };
}

/** An imported proxy's pool name: its host and port, never its user name or password. */
export function batchName(url: string): string {
  const u = new URL(url);
  return u.port ? `${u.hostname}:${u.port}` : u.hostname;
}

export const MAX_BATCH = 50;

/** Proxies typed one per line for a batch import, each with its line number: blank lines and repeats dropped. */
export function batchLines(text: string): { line: number; url: string }[] {
  const out: { line: number; url: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const url = raw.trim().replace(/\/+$/, "");
    if (url && !out.some((x) => x.url === url)) out.push({ line: i + 1, url });
  });
  return out;
}

/** The command that runs the relay in this repository on a host outside Cloudflare. */
export const RELAY_COMMAND = 'RELAY_SECRET="<shared secret, 32+ characters>" PORT=8790 node relay/codex-relay.mjs';

type Pending = { kind: "add" } | { kind: "batch" } | { kind: "edit"; pool: ProxyPool } | { kind: "delete"; pool: ProxyPool } | null;

/**
 * Proxy pools: named sets of exits that a connection sends its upstream calls through. An exit is an HTTPS relay
 * (`relay/codex-relay.mjs`), or an HTTP or SOCKS5 proxy that the worker reaches over a raw socket
 * (worker/socket-fetch.ts). A proxy's user name and password are sent once and never read back.
 */
export function ProxyPools() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [pools, reload] = useLoad<ProxyPool[]>("/proxy-pools");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const closeDialog = () => {
    setPending(null);
    setDialogError(null);
  };

  /** Runs an action; its error shows in the open dialog when `inDialog`, else on the page. */
  async function run(action: () => Promise<void>, inDialog = false) {
    setBusy(true);
    setError(null);
    setDialogError(null);
    try {
      await action();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) (inDialog ? setDialogError : setError)(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const test = async (pool: ProxyPool) => {
    setTesting(pool.id);
    setError(null);
    try {
      const r = await api<{ relays: RelayCheck[] }>(`/proxy-pools/${encodeURIComponent(pool.id)}/test`, { method: "POST" });
      notify(t("pools.tested", { name: pool.name, ok: String(r.relays.filter((x) => x.ok).length), total: String(r.relays.length) }));
      reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("pools.testFailed", { name: pool.name }));
    } finally {
      setTesting(null);
    }
  };

  const remove = (pool: ProxyPool) =>
    run(async () => {
      await api(`/proxy-pools/${encodeURIComponent(pool.id)}`, { method: "DELETE" });
      notify(t("pools.deleted", { name: pool.name }));
      closeDialog();
      reload();
    }, true);

  const relayLine = (pool: ProxyPool, url: string) => {
    const check = pool.last_check?.find((c) => c.url === url);
    if (!check) return <StatusDot tone="neutral" label={t("pools.relayUnchecked", { url })} />;
    if (check.ok) return <StatusDot tone="ok" label={t("pools.relayOk", { url, ms: String(check.ms) })} />;
    if (check.error) return <StatusDot tone="danger" label={t("pools.relayError", { url, error: check.error })} />;
    return <StatusDot tone="danger" label={t("pools.relayFailed", { url, status: check.status ? String(check.status) : "-" })} />;
  };

  const list = pools.status === "ready" ? pools.data : null;
  const counts = poolCounts(list ?? []);

  return (
    <Stack gap={4}>
      <div className="page-actions">
        <p className="page-intro">{t("pools.intro")}</p>
        <Button icon="upload" onClick={() => setPending({ kind: "batch" })}>
          {t("pools.batch")}
        </Button>
        <Button variant="primary" icon="plus" onClick={() => setPending({ kind: "add" })}>
          {t("pools.add")}
        </Button>
      </div>
      {list && (
        <div className="pool-counts">
          <Badge>{t("pools.total", { n: String(counts.total) })}</Badge>
          <Badge status="new">{t("pools.active", { n: String(counts.active) })}</Badge>
        </div>
      )}
      {error && <Banner tone="danger" title={error} />}
      {pools.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
      {pools.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {list && list.length === 0 && (
        <EmptyState
          icon="server"
          size="center"
          title={t("pools.empty")}
          hint={t("pools.emptyHint")}
          actions={
            <Button icon="plus" onClick={() => setPending({ kind: "add" })}>
              {t("pools.add")}
            </Button>
          }
        />
      )}
      {list && list.length > 0 && (
        <Card title={t("pools.list")} titleAside={<span className="providers-section-count">{list.length}</span>} headingLevel={2} flush>
          <div>
            {list.map((pool) => (
              <ListRow
                key={pool.id}
                className="account-row"
                leading={<Emblem name={pool.name} icon="server" />}
                title={pool.name}
                meta={
                  <>
                    <span className="account-meta-line">
                      {t("pools.relayCount", { n: String(entriesOf(pool).length) })} · {t("pools.usedBy", { n: String(pool.connections) })}
                      {pool.hint ? ` · ${t("pools.secretHint", { hint: pool.hint })}` : ""}
                    </span>
                    {pool.relays.map((url) => (
                      <span key={url} className="account-meta-line">
                        {relayLine(pool, url)}
                      </span>
                    ))}
                    {(pool.proxies ?? []).map((p) => (
                      <span key={p.url} className="account-meta-line">
                        {relayLine(pool, p.url)}
                        {p.has_auth ? ` · ${t("pools.proxyAuth")}` : ""}
                      </span>
                    ))}
                  </>
                }
                trailing={
                  <>
                    <Button size="sm" disabled={busy || testing !== null} onClick={() => void test(pool)} aria-label={t("pools.testName", { name: pool.name })}>
                      {testing === pool.id ? t("pools.testing") : t("pools.test")}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => setPending({ kind: "edit", pool })} aria-label={t("pools.editName", { name: pool.name })}>
                      {t("pools.edit")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending({ kind: "delete", pool })} aria-label={t("pools.deleteName", { name: pool.name })}>
                      {t("pools.delete")}
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        </Card>
      )}
      <Card title={t("pools.deployTitle")} headingLevel={2}>
        <Stack gap={3}>
          <p className="muted">{t("pools.deployBody")}</p>
          <CodeBlock language="bash" code={RELAY_COMMAND} labels={labels.codeBlock} />
        </Stack>
      </Card>
      {(pending?.kind === "add" || pending?.kind === "edit") && (
        <PoolDialog
          pool={pending.kind === "edit" ? pending.pool : null}
          onCancel={() => setPending(null)}
          onSaved={(name, created) => {
            notify(t(created ? "pools.created" : "pools.saved", { name }));
            setPending(null);
            reload();
          }}
        />
      )}
      {pending?.kind === "batch" && (
        <BatchDialog
          onCancel={() => setPending(null)}
          onDone={(ok, failed) => {
            setPending(null);
            reload();
            if (ok > 0) notify(t("pools.imported", { n: String(ok) }));
            if (failed.length > 0) setError(t("pools.batchSome", { failed: String(failed.length), total: String(ok + failed.length), lines: failed.join(", ") }));
          }}
        />
      )}
      {pending?.kind === "delete" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("pools.deleteTitle", { name: pending.pool.name })}
          labels={labels.dialog}
          confirmLabel={t("pools.delete")}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={() => void remove(pending.pool)}
        >
          <Stack gap={2}>
            <span>{pending.pool.connections > 0 ? t("pools.deleteBodyUsed", { n: String(pending.pool.connections) }) : t("pools.deleteBody")}</span>
            {dialogError && <Banner tone="danger" title={dialogError} />}
          </Stack>
        </Dialog>
      )}
    </Stack>
  );
}

/** Adds a pool, or edits one. The secret is sent once and never read back; on edit an empty field keeps it. */
function PoolDialog({ pool, onCancel, onSaved }: { pool: ProxyPool | null; onCancel: () => void; onSaved: (name: string, created: boolean) => void }) {
  const [lang] = useLang();
  const [name, setName] = useState(pool?.name ?? "");
  const [relaysText, setRelaysText] = useState(pool ? entriesOf(pool).join("\n") : "");
  const [secret, setSecret] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const relays = parseRelays(relaysText);
  const nameError = trimmedName.length < 1 || trimmedName.length > 100 ? t("pools.nameBad") : undefined;
  // A bad entry is named by its line, not its text, which may hold a proxy password.
  const bad = relays.findIndex((u) => !validEntry(u));
  const relaysError =
    relays.length === 0 ? t("pools.relaysNone") : relays.length > MAX_RELAYS ? t("pools.relaysMany", { n: String(MAX_RELAYS) }) : bad >= 0 ? t("pools.entryBad", { n: String(bad + 1) }) : undefined;
  // The secret is for relays: needed when the list has one and the pool has no secret yet, or when a new one is typed.
  const needSecret = hasRelay(relays) && !pool?.hint;
  const secretError = (needSecret || secret.length > 0) && secret.length < MIN_SECRET ? t("pools.secretBad", { n: String(MIN_SECRET) }) : undefined;

  async function submit() {
    setTried(true);
    if (nameError || relaysError || secretError) return;
    setBusy(true);
    setError(null);
    try {
      if (pool === null) {
        await api("/proxy-pools", { method: "POST", body: { name: trimmedName, relays, secret } });
      } else {
        const body: { name?: string; relays?: string[]; secret?: string } = {};
        if (trimmedName !== pool.name) body.name = trimmedName;
        if (relays.join("\n") !== entriesOf(pool).join("\n")) body.relays = relays;
        if (secret) body.secret = secret;
        if (Object.keys(body).length > 0) await api(`/proxy-pools/${encodeURIComponent(pool.id)}`, { method: "PATCH", body });
      }
      setSecret("");
      onSaved(trimmedName, pool === null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      // A plain headline first; the gateway's own reason, when it gave one, one line under it.
      setError(e instanceof ApiError && e.status === 400 && e.detail ? e.detail : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={pool ? t("pools.editTitle", { name: pool.name }) : t("pools.addTitle")}
      description={t("pools.dialogNote")}
      submitLabel={pool ? t("common.save") : t("pools.add")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={
        error ? (
          <>
            <strong>{t("ux.pools.saveFailed")}</strong> {error}
          </>
        ) : undefined
      }
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field label={t("pools.name")} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} error={tried ? nameError : undefined} />
      <Textarea
        label={t("pools.relays")}
        hint={t("pools.relaysHint", { n: String(MAX_RELAYS) })}
        mono
        rows={4}
        value={relaysText}
        spellCheck={false}
        placeholder={"https://relay-1.example.com\nsocks5://user:pass@203.0.113.7:1080\nhttp://198.51.100.4:3128"}
        onChange={(e) => setRelaysText(e.target.value)}
        error={tried ? relaysError : undefined}
      />
      <Field
        label={t("pools.secret")}
        hint={pool?.hint ? t("pools.secretKeepHint", { hint: pool.hint, n: String(MIN_SECRET) }) : t("pools.secretHintNew", { n: String(MIN_SECRET) })}
        type="password"
        value={secret}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setSecret(e.target.value)}
        error={tried ? secretError : undefined}
      />
    </FormDialog>
  );
}

/**
 * Batch import: one pool per HTTP or SOCKS5 proxy, named by its host and port. Relays need a secret, so they are
 * added with Add pool. Each pool is created on its own; the lines that were refused are named by number.
 */
function BatchDialog({ onCancel, onDone }: { onCancel: () => void; onDone: (ok: number, failedLines: number[]) => void }) {
  const [lang] = useLang();
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  const lines = batchLines(text);
  // A bad line is named by its number, not its text, which may hold a proxy password.
  const bad = lines.find((l) => l.url.startsWith("https:") || !validEntry(l.url));
  const fieldError =
    lines.length === 0
      ? t("pools.batchNone")
      : lines.length > MAX_BATCH
        ? t("pools.batchMany", { n: String(MAX_BATCH) })
        : bad
          ? t("pools.batchBad", { n: String(bad.line) })
          : undefined;

  async function submit() {
    setTried(true);
    if (fieldError) return;
    setBusy(true);
    let ok = 0;
    const failed: number[] = [];
    for (const l of lines) {
      try {
        await api("/proxy-pools", { method: "POST", body: { name: batchName(l.url), relays: [l.url], secret: "" } });
        ok++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setBusy(false);
          return;
        }
        failed.push(l.line);
      }
    }
    setBusy(false);
    setText("");
    onDone(ok, failed);
  }

  return (
    <FormDialog
      title={t("pools.batchTitle")}
      description={t("pools.batchNote")}
      submitLabel={t("pools.batchSubmit")}
      labels={ui(lang).formDialog}
      busy={busy}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Textarea
        label={t("pools.batchField")}
        hint={t("pools.batchHint", { n: String(MAX_BATCH) })}
        mono
        rows={8}
        value={text}
        spellCheck={false}
        placeholder={"socks5://user:pass@203.0.113.7:1080\nhttp://198.51.100.4:3128"}
        onChange={(e) => setText(e.target.value)}
        error={tried ? fieldError : undefined}
      />
    </FormDialog>
  );
}
