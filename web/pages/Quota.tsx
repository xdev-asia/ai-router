import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  Button,
  Card,
  DataTable,
  Dialog,
  Emblem,
  EmptyState,
  IconButton,
  Meter,
  Pagination,
  Select,
  Skeleton,
  Stack,
  StatusDot,
  Switch,
  Tag,
  type DataTableColumn,
  type MeterTone,
} from "@xdev-asia/ui";
import { ApiError, api, useLoad, type Connection, type Provider } from "../api";
import { formatNumber, t, useLang, type Lang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { providerLogo } from "../provider-logos";
import { ui } from "../ui-labels";

/** worker/quota.ts QuotaWindow: one limit of an account. */
export interface QuotaWindow {
  name: string;
  kind: "percent" | "count" | "balance";
  used: number;
  total: number;
  remaining_percent: number;
  reset_at: number | null;
  currency?: string;
}

/** worker/quota.ts QuotaReport: what a provider says is left on one account. */
export interface QuotaReport {
  plan: string | null;
  windows: QuotaWindow[];
  limit_reached: boolean;
  reset_credits: number | null;
  message: string | null;
  error: { status: number; message: string } | null;
}

interface QuotaList {
  providers: string[];
  connections: Connection[];
  /** Window names the owner hid, per provider. */
  hidden: Record<string, string[]>;
}

interface ResetCredits {
  available_count: number;
  credits: { status: string; granted_at: number | null; expires_at: number | null }[];
}

export type QuotaSort = "default" | "high" | "low";
export type QuotaStatus = "all" | "active" | "off";
export interface QuotaFilter {
  provider: string;
  status: QuotaStatus;
  sort: QuotaSort;
  expiringFirst: boolean;
}

/** An account at or under this much left counts as empty ("Turn off Empty"). */
const EMPTY_AT = 5;
const PAGE_SIZES = [10, 20, 50, 100];
const AUTO_REFRESH_MS = 60_000;
const AUTO_KEY = "ai-router.quotaAutoRefresh";

/** Green above 70% left, yellow from 30 to 70, red below 30. */
export const quotaTone = (remaining: number): MeterTone => (remaining > 70 ? "ok" : remaining >= 30 ? "warn" : "danger");

/** The tightest window's percent left; null when the report is missing, failed or has no window. */
export function leastLeft(r: QuotaReport | undefined): number | null {
  if (!r || r.error || r.windows.length === 0) return null;
  return Math.min(...r.windows.map((w) => w.remaining_percent));
}

/** The soonest reset among the windows (unix seconds); null when none says. */
export function nextReset(r: QuotaReport | undefined): number | null {
  const times = (r?.error ? [] : (r?.windows ?? [])).map((w) => w.reset_at).filter((x): x is number => x !== null);
  return times.length ? Math.min(...times) : null;
}

const WINDOW_BASE: Record<string, StringKey> = { session: "quota.window.session", weekly: "quota.window.weekly" };
const WINDOW_GROUP: Record<string, StringKey> = { review_: "quota.window.review", spark_: "quota.window.spark" };

/** Codex windows by name ("Code review · Weekly"); any other name as the provider gave it. */
export function windowLabel(name: string): string {
  const group = Object.keys(WINDOW_GROUP).find((p) => name.startsWith(p));
  const base = group ? name.slice(group.length) : name;
  const key = WINDOW_BASE[base];
  if (!key) return name;
  return group ? `${t(WINDOW_GROUP[group]!)} · ${t(key)}` : t(key);
}

/** What is left, in the window's own unit. */
export function windowValue(w: QuotaWindow): string {
  if (w.kind === "balance") return `${w.total.toFixed(2)} ${w.currency ?? ""}`.trim();
  if (w.kind === "count") return t("quota.left.count", { left: formatNumber(Math.max(0, w.total - w.used)), total: formatNumber(w.total) });
  return t("quota.left.percent", { n: String(Math.round(w.remaining_percent)) });
}

/** "in 3h 15m"; "now" once the time has passed. */
export function resetIn(at: number, now: number): string {
  const left = at - now;
  if (left <= 0) return t("quota.reset.now");
  // Round up to whole minutes first, then split, so 4h 59m 30s reads "5h 0m", never "4h 60m".
  const mins = Math.ceil(left / 60);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return t("quota.reset.days", { d: String(d), h: String(h) });
  if (h > 0) return t("quota.reset.hours", { h: String(h), m: String(m) });
  return t("quota.reset.minutes", { m: String(m) });
}

/** Filters, then sorts: provider order and account order by default; unknown quotas stay last. */
export function arrange(rows: Connection[], reports: Record<string, QuotaReport | undefined>, f: QuotaFilter, providerOrder: readonly string[] = ["codex", "groq", "deepseek"]): Connection[] {
  const rank = (p: string) => {
    const i = providerOrder.indexOf(p);
    return i === -1 ? providerOrder.length : i;
  };
  const kept = rows.filter((c) => (f.provider === "all" || c.provider === f.provider) && (f.status === "all" || (f.status === "off") === c.disabled));
  const byLeft = (a: Connection, b: Connection): number => {
    if (f.sort === "default") return 0;
    const x = leastLeft(reports[a.id]);
    const y = leastLeft(reports[b.id]);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return f.sort === "high" ? y - x : x - y;
  };
  const bySoonest = (a: Connection, b: Connection): number => {
    if (!f.expiringFirst) return 0;
    const x = nextReset(reports[a.id]);
    const y = nextReset(reports[b.id]);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return x - y;
  };
  return [...kept].sort((a, b) => bySoonest(a, b) || byLeft(a, b) || rank(a.provider) - rank(b.provider) || a.priority - b.priority);
}

/** Active accounts with 5% or less left; an account whose quota is unknown is left alone. */
export function emptyToTurnOff(rows: Connection[], reports: Record<string, QuotaReport | undefined>): Connection[] {
  return rows.filter((c) => {
    const left = leastLeft(reports[c.id]);
    return !c.disabled && left !== null && left <= EMPTY_AT;
  });
}

/** Accounts that are off but have more than 5% left. */
export function availableToTurnOn(rows: Connection[], reports: Record<string, QuotaReport | undefined>): Connection[] {
  return rows.filter((c) => {
    const left = leastLeft(reports[c.id]);
    return c.disabled && left !== null && left > EMPTY_AT;
  });
}

const formatDate = (at: number | null, lang: Lang) =>
  at === null ? "—" : new Date(at * 1000).toLocaleString(lang === "vi" ? "vi-VN" : "en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAuto(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    // storage unavailable: the choice lasts for this page view only
  }
}

type Reports = Record<string, QuotaReport | undefined>;

/** Quota Tracker: what each account has left, with its reset time. */
export function Quota() {
  const [lang] = useLang();
  const notify = useNotify();
  const [list, reloadList] = useLoad<QuotaList>("/quota");
  const [providers] = useLoad<Provider[]>("/providers");
  const [reports, setReports] = useState<Reports>({});
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState<Record<string, string[]>>({});
  const [filter, setFilter] = useState<QuotaFilter>({ provider: "all", status: "all", sort: "default", expiringFirst: false });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [auto, setAuto] = useState(readAuto);
  const [busy, setBusy] = useState(false);
  const [credits, setCredits] = useState<Connection | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const rows = useMemo(() => (list.status === "ready" ? list.data.connections : []), [list]);
  const info = useMemo(() => new Map((providers.status === "ready" ? providers.data : []).map((p) => [p.id, p])), [providers]);
  const order = list.status === "ready" ? list.data.providers : undefined;

  useEffect(() => {
    if (list.status === "ready") setHidden(list.data.hidden);
  }, [list]);

  const load = useCallback(async (id: string) => {
    setLoading((s) => new Set(s).add(id));
    try {
      const r = await api<QuotaReport>(`/quota/${encodeURIComponent(id)}`);
      setReports((m) => ({ ...m, [id]: r }));
    } catch (e) {
      const message = e instanceof ApiError ? (e.detail ?? e.code) : t("error.generic");
      setReports((m) => ({ ...m, [id]: { plan: null, windows: [], limit_reached: false, reset_credits: null, message: null, error: { status: 0, message } } }));
    } finally {
      setLoading((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      setNow(Math.floor(Date.now() / 1000));
    }
  }, []);

  // Each account's report once the list is in; a reload of the list (Refresh all) asks again.
  useEffect(() => {
    if (list.status !== "ready") return;
    list.data.connections.forEach((c) => void load(c.id));
  }, [list, load]);

  const refreshAll = useCallback(() => reloadList(), [reloadList]);
  const refreshRef = useRef(refreshAll);
  refreshRef.current = refreshAll;

  // Auto-refresh every minute while the tab is in view.
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [auto]);

  // Keep the "resets in" text moving between refreshes.
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);

  const arranged = useMemo(() => arrange(rows, reports, filter, order), [rows, reports, filter, order]);
  const pages = Math.max(1, Math.ceil(arranged.length / pageSize));
  const current = Math.min(page, pages);
  const shown = arranged.slice((current - 1) * pageSize, current * pageSize);
  const toOff = emptyToTurnOff(rows, reports);
  const toOn = availableToTurnOn(rows, reports);

  const setDisabled = async (targets: Connection[], disabled: boolean) => {
    setBusy(true);
    try {
      for (const c of targets) await api(`/connections/${encodeURIComponent(c.id)}`, { method: "PATCH", body: { disabled } });
      notify(t(disabled ? "quota.turnedOff" : "quota.turnedOn", { n: String(targets.length) }));
    } catch {
      notify(t("error.generic"));
    } finally {
      setBusy(false);
      reloadList();
    }
  };

  const toggleHidden = async (provider: string, name: string) => {
    const names = hidden[provider] ?? [];
    const next = names.includes(name) ? names.filter((n) => n !== name) : [...names, name];
    try {
      setHidden(await api<Record<string, string[]>>("/quota/hidden", { method: "PUT", body: { provider, names: next } }));
    } catch {
      notify(t("error.generic"));
    }
  };

  const update = (patch: Partial<QuotaFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const filtered = filter.provider !== "all" || filter.status !== "all";
  const providerName = (id: string) => info.get(id)?.name ?? id;
  const hiddenList = Object.entries(hidden).flatMap(([p, names]) => names.map((n) => ({ provider: p, name: n })));

  if (list.status === "loading") return <Skeleton lines={4} announce labels={{ loading: t("loading") }} />;
  if (list.status === "error") return <Banner tone="danger" title={t("error.load")} action={<Button onClick={reloadList}>{t("common.retry")}</Button>} />;

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState size="center" icon="cloud" title={t("quota.empty")} hint={t("quota.emptyHint")} actions={<Button href="#/providers">{t("quota.connect")}</Button>} />
      </Card>
    );
  }

  return (
    <Stack gap={4}>
      <div className="quota-tools">
        <div className="quota-filters">
          <Select
            aria-label={t("quota.filter.provider")}
            value={filter.provider}
            onChange={(e) => update({ provider: e.target.value })}
            options={[{ value: "all", label: t("quota.filter.allProviders") }, ...(order ?? []).filter((p) => rows.some((c) => c.provider === p)).map((p) => ({ value: p, label: providerName(p) }))]}
          />
          <Select
            aria-label={t("quota.filter.status")}
            value={filter.status}
            onChange={(e) => update({ status: e.target.value as QuotaStatus })}
            options={[
              { value: "all", label: t("quota.filter.allAccounts") },
              { value: "active", label: t("quota.filter.active") },
              { value: "off", label: t("quota.filter.off") },
            ]}
          />
          <Select
            aria-label={t("quota.sort")}
            value={filter.sort}
            onChange={(e) => update({ sort: e.target.value as QuotaSort })}
            options={[
              { value: "default", label: t("quota.sort.default") },
              { value: "high", label: t("quota.sort.high") },
              { value: "low", label: t("quota.sort.low") },
            ]}
          />
          <Switch label={t("quota.expiringFirst")} checked={filter.expiringFirst} onChange={(e) => update({ expiringFirst: e.target.checked })} />
        </div>
        <div className="quota-actions">
          <Button icon="eye-off" disabled={busy || toOff.length === 0} onClick={() => void setDisabled(toOff, true)}>
            {t("quota.turnOffEmpty", { n: String(toOff.length) })}
          </Button>
          <Button icon="eye" disabled={busy || toOn.length === 0} onClick={() => void setDisabled(toOn, false)}>
            {t("quota.turnOnAvailable", { n: String(toOn.length) })}
          </Button>
          <Switch
            label={t("quota.autoRefresh")}
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              saveAuto(e.target.checked);
            }}
          />
          <IconButton icon="refresh" label={t("quota.refreshAll")} disabled={loading.size > 0} onClick={refreshAll} />
        </div>
      </div>

      {hiddenList.length > 0 && (
        <div className="quota-hidden">
          <span>{t("quota.hidden")}</span>
          {hiddenList.map((h) => (
            <Tag key={`${h.provider}/${h.name}`} onRemove={() => void toggleHidden(h.provider, h.name)} removeLabel={t("quota.show", { name: windowLabel(h.name) })}>
              {providerName(h.provider)} · {windowLabel(h.name)}
            </Tag>
          ))}
        </div>
      )}

      {arranged.length === 0 ? (
        <Card>
          <EmptyState
            icon="filter"
            title={t("quota.noMatch")}
            actions={filtered ? <Button onClick={() => update({ provider: "all", status: "all" })}>{t("quota.clearFilters")}</Button> : undefined}
          />
        </Card>
      ) : (
        <Stack gap={3}>
          {shown.map((c) => (
            <Account
              key={c.id}
              conn={c}
              provider={info.get(c.provider)}
              report={reports[c.id]}
              loading={loading.has(c.id)}
              hidden={hidden[c.provider] ?? []}
              now={now}
              busy={busy}
              onRefresh={() => void load(c.id)}
              onToggle={() => void setDisabled([c], !c.disabled)}
              onHide={(name) => void toggleHidden(c.provider, name)}
              onCredits={() => setCredits(c)}
            />
          ))}
        </Stack>
      )}

      {arranged.length > PAGE_SIZES[0]! && (
        <Pagination
          page={current}
          pageSize={pageSize}
          total={arranged.length}
          onPageChange={setPage}
          pageSizeOptions={PAGE_SIZES}
          onPageSizeChange={(n) => {
            setPageSize(n);
            setPage(1);
          }}
          labels={{
            nav: t("quota.pages"),
            previous: t("quota.prev"),
            next: t("quota.next"),
            pageSize: t("quota.pageSize"),
            range: (from, to, total) => t("quota.range", { from: String(from), to: String(to), total: String(total) }),
          }}
        />
      )}

      {credits && (
        <CreditsDialog
          conn={credits}
          lang={lang}
          onClose={() => setCredits(null)}
          onReset={() => {
            setCredits(null);
            void load(credits.id);
          }}
        />
      )}
      <span className="x-sr-only" role="status">
        {loading.size > 0 ? t("loading") : ""}
      </span>
    </Stack>
  );
}

function accountState(c: Connection, r: QuotaReport | undefined): { tone: "ok" | "warn" | "danger" | "neutral"; key: StringKey } {
  if (c.disabled) return { tone: "neutral", key: "quota.state.off" };
  if (r?.error) return { tone: "danger", key: "quota.state.error" };
  if (r?.limit_reached) return { tone: "danger", key: "quota.state.limit" };
  return { tone: "ok", key: "quota.state.active" };
}

function Account(props: {
  conn: Connection;
  provider: Provider | undefined;
  report: QuotaReport | undefined;
  loading: boolean;
  hidden: string[];
  now: number;
  busy: boolean;
  onRefresh: () => void;
  onToggle: () => void;
  onHide: (name: string) => void;
  onCredits: () => void;
}) {
  const { conn: c, provider: p, report: r, loading, hidden, now } = props;
  const state = accountState(c, r);
  const windows = (r?.windows ?? []).filter((w) => !hidden.includes(w.name));
  const subtitle = [p?.name ?? c.provider, r?.plan && r.plan !== p?.name ? r.plan : null].filter(Boolean).join(" · ");
  return (
    <Card
      title={
        <span className="quota-account">
          <Emblem name={p?.name ?? c.provider} text={p?.mark} color={p?.color} src={providerLogo(c.provider)} size="sm" />
          <span className="quota-account-name">{c.name}</span>
        </span>
      }
      subtitle={subtitle}
      actions={
        <span className="quota-account-actions">
          <StatusDot tone={state.tone} label={t(state.key)} />
          {c.provider === "codex" && (
            <IconButton icon="restore" label={t("quota.credits.open", { name: c.name })} disabled={props.busy} onClick={props.onCredits} />
          )}
          <IconButton icon="refresh" label={t("quota.refreshOne", { name: c.name })} disabled={loading} onClick={props.onRefresh} />
          <Switch aria-label={t("quota.toggle", { name: c.name })} checked={!c.disabled} disabled={props.busy} onChange={props.onToggle} />
        </span>
      }
    >
      {!r && loading ? (
        <Skeleton lines={2} labels={{ loading: t("loading") }} />
      ) : r?.error ? (
        <Banner tone="danger" title={r.error.message} />
      ) : r?.message ? (
        <p className="muted">{r.message}</p>
      ) : windows.length === 0 ? (
        <p className="muted">{r && r.windows.length > 0 ? t("quota.allHidden") : t("quota.noWindows")}</p>
      ) : (
        <ul className="quota-windows">
          {windows.map((w) => (
            <li key={w.name} className="quota-window">
              <Meter
                fill
                label={windowLabel(w.name)}
                value={w.kind === "balance" ? (w.total > 0 ? 100 : 0) : w.remaining_percent}
                tone={w.kind === "balance" ? (w.total > 0 ? "ok" : "danger") : quotaTone(w.remaining_percent)}
                valueText={windowValue(w)}
              />
              <span className="quota-reset">{w.reset_at === null ? "" : t("quota.resets", { when: resetIn(w.reset_at, now) })}</span>
              <IconButton icon="eye-off" size="sm" label={t("quota.hide", { name: windowLabel(w.name) })} onClick={() => props.onHide(w.name)} />
            </li>
          ))}
        </ul>
      )}
      {r && !r.error && r.reset_credits !== null && r.reset_credits > 0 && (
        <p className="quota-credits">{t("quota.credits.count", { n: String(r.reset_credits) })}</p>
      )}
    </Card>
  );
}

type CreditRow = ResetCredits["credits"][number] & { key: string };

/** What the gateway said about a failed call, for the line under a plain headline. */
const failure = (e: unknown): string => (e instanceof ApiError ? (e.detail ?? e.code) : t("error.generic"));

/** A Codex account's reset credits, and the button that spends one. */
export function CreditsDialog({ conn, lang, onClose, onReset }: { conn: Connection; lang: Lang; onClose: () => void; onReset: () => void }) {
  const notify = useNotify();
  const [data, setData] = useState<ResetCredits | null>(null);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api<ResetCredits>(`/quota/${encodeURIComponent(conn.id)}/reset-credits`).then(
      (d) => live && setData(d),
      (e: unknown) => live && setError({ title: t("ux.quota.credits.loadFailed"), detail: failure(e) }),
    );
    return () => {
      live = false;
    };
  }, [conn.id]);

  const reset = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ windows_reset: number }>(`/quota/${encodeURIComponent(conn.id)}/reset-credit`, { method: "POST", body: {} });
      notify(t("quota.credits.done", { n: String(r.windows_reset) }));
      onReset();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? { title: t("quota.credits.none") } : { title: t("ux.quota.credits.resetFailed"), detail: failure(e) });
      setSaving(false);
    }
  };

  // Only "available" is known to mean a usable credit; any other status is shown as unusable, with its own word.
  const statusLabel = (status: string) => (status === "available" ? t("ux.quota.credit.available") : t("ux.quota.credit.other", { status }));
  const columns: DataTableColumn<CreditRow>[] = [
    { key: "status", header: t("quota.credits.status"), cell: (x) => <StatusDot tone={x.status === "available" ? "ok" : "neutral"} label={statusLabel(x.status)} /> },
    { key: "granted", header: t("quota.credits.granted"), cell: (x) => formatDate(x.granted_at, lang) },
    { key: "expires", header: t("quota.credits.expires"), cell: (x) => formatDate(x.expires_at, lang) },
  ];
  const rows: CreditRow[] = (data?.credits ?? []).map((x, i) => ({ ...x, key: String(i) }));

  return (
    <Dialog
      modal
      size="wide"
      title={t("quota.credits.title", { name: conn.name })}
      description={data ? t("quota.credits.available", { n: String(data.available_count) }) : undefined}
      confirmLabel={saving ? t("common.saving") : t("quota.credits.reset")}
      confirmDisabled={saving || !data || data.available_count === 0}
      cancelLabel={t("common.close")}
      onConfirm={() => void reset()}
      onCancel={onClose}
      body="plain"
    >
      {error && (
        <Banner tone="danger" title={error.title}>
          {error.detail}
        </Banner>
      )}
      {!data && !error && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
      {data && (
        <DataTable
          caption={t("quota.credits.caption")}
          columns={columns}
          rows={rows}
          rowKey={(x) => x.key}
          labels={ui(lang).dataTable}
          empty={<EmptyState icon="inbox" title={t("quota.credits.empty")} />}
        />
      )}
    </Dialog>
  );
}
