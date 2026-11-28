import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  Button,
  Card,
  DataTable,
  Dialog,
  Emblem,
  EmptyState,
  Grid,
  IconButton,
  Meter,
  Pagination,
  Select,
  Skeleton,
  Stack,
  StatTile,
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
  /** percent and count: a share of a limit; spend: money used of a limit; balance: money left (`total`). */
  kind: "percent" | "count" | "spend" | "balance";
  used: number;
  total: number;
  remaining_percent: number;
  reset_at: number | null;
  /** Length of the cycle in seconds; null when the limit has none or it is unknown. */
  period_seconds: number | null;
  currency?: string;
}

/** worker/quota.ts QuotaReport: what a provider says about one account. */
export interface QuotaReport {
  plan: string | null;
  /** Whether the plan is the provider's free one; null when unknown. */
  tier?: "free" | "paid" | null;
  /** ChatGPT Business seat, read from the windows (a Premium seat has no 5-hour window). */
  seat?: "standard" | "premium" | null;
  windows: QuotaWindow[];
  limit_reached: boolean;
  reset_credits: number | null;
  /** The model the limits were read for, when they are per model (Groq). */
  scope?: string | null;
  /** Unix seconds: when the provider was asked; earlier than now for a kept answer. */
  checked_at?: number;
  message: string | null;
  error: { status: number; message: string } | null;
}

interface QuotaList {
  providers: string[];
  connections: Connection[];
  /** Window names the owner hid, per provider. */
  hidden: Record<string, string[]>;
  /** Connected providers that report neither a plan nor a quota, with how many accounts each has. */
  others?: { provider: string; accounts: number }[];
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
/** Under this much left an account is running low. */
const LOW_AT = 30;
/** A kept answer older than this says when it was read. */
const STALE_S = 120;
const DAY_S = 86400;
const PAGE_SIZES = [10, 20, 50, 100];
const AUTO_REFRESH_MS = 60_000;
const AUTO_KEY = "ai-router.quotaAutoRefresh";

/** Green above 70% left, yellow from 30 to 70, red below 30. */
export const quotaTone = (remaining: number): MeterTone => (remaining > 70 ? "ok" : remaining >= LOW_AT ? "warn" : "danger");

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

const WINDOW_BASE: Record<string, StringKey> = {
  session: "quota.window.session",
  weekly: "quota.window.weekly",
  Requests: "quota.window.requests",
  Tokens: "quota.window.tokens",
  free_requests: "quota.window.freeRequests",
  key_limit: "quota.window.keyLimit",
  credits: "quota.window.credits",
  premium_interactions: "quota.window.premium",
  chat: "quota.window.chat",
  completions: "quota.window.completions",
};
const WINDOW_GROUP: Record<string, StringKey> = { review_: "quota.window.review", spark_: "quota.window.spark" };

/** A window by name ("Code review · Weekly", "Free-model requests"); a name this page does not know as the provider gave it. */
export function windowLabel(name: string): string {
  const group = Object.keys(WINDOW_GROUP).find((p) => name.startsWith(p));
  const base = group ? name.slice(group.length) : name;
  const key = WINDOW_BASE[base];
  if (!key) return name;
  return group ? `${t(WINDOW_GROUP[group]!)} · ${t(key)}` : t(key);
}

/** The share of the limit that is used, 0 to 100: what the bar shows. */
export const usedPercent = (w: QuotaWindow): number => Math.min(100, Math.max(0, 100 - w.remaining_percent));

const money = (n: number, currency: string | undefined): string => (currency === "USD" || !currency ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`);

/** What is used, in the window's own unit; a balance says what is left. */
export function windowValue(w: QuotaWindow): string {
  if (w.kind === "balance") return t("quota.left.money", { amount: money(w.total, w.currency) });
  if (w.kind === "spend") return t("quota.used.count", { used: money(w.used, w.currency), total: money(w.total, w.currency) });
  if (w.kind === "count") return t("quota.used.count", { used: formatNumber(w.used), total: formatNumber(w.total) });
  return t("quota.used.percent", { n: String(Math.round(usedPercent(w))) });
}

/** The text after the bar: the percent used, "<1%" for a first small use; a balance says what is left. */
export function meterText(w: QuotaWindow): string {
  if (w.kind === "balance" || w.kind === "percent") return windowValue(w);
  const used = usedPercent(w);
  return t("quota.used.percent", { n: used > 0 && used < 1 ? "<1" : String(Math.round(used)) });
}

/** How often a limit starts again ("Every 5 hours", "Daily"); null when the provider does not say. */
export function cycleLabel(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds === 60) return t("quota.cycle.minute");
  if (seconds < 3600) return t("quota.cycle.minutes", { n: String(Math.round(seconds / 60)) });
  if (seconds === 3600) return t("quota.cycle.hour");
  if (seconds < DAY_S) return t("quota.cycle.hours", { n: String(Math.round(seconds / 3600)) });
  if (seconds === DAY_S) return t("quota.cycle.day");
  if (seconds === 7 * DAY_S) return t("quota.cycle.week");
  const days = Math.round(seconds / DAY_S);
  if (days >= 28 && days <= 31) return t("quota.cycle.month");
  return t("quota.cycle.days", { n: String(days) });
}

/** The provider's plan name as a label ("plus": "Plus", "free_educational_quota": "Free educational quota"); null when it names none. */
export function planLabel(plan: string | null | undefined): string | null {
  if (!plan || plan === "unknown") return null;
  const words = plan.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
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

/** The first letter in upper case, for a line put together from parts ("checked 12 min ago" first in its line). */
export const sentence = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** "12 min ago", "3 h ago", "2 d ago". */
export function ago(at: number, now: number): string {
  const mins = Math.max(1, Math.round((now - at) / 60));
  if (mins < 60) return t("quota.ago.minutes", { n: String(mins) });
  if (mins < 1440) return t("quota.ago.hours", { n: String(Math.round(mins / 60)) });
  return t("quota.ago.days", { n: String(Math.round(mins / 1440)) });
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

/** The accounts under their provider, providers and accounts in the order they came. */
export function groupByProvider(rows: Connection[]): { provider: string; rows: Connection[] }[] {
  const groups = new Map<string, Connection[]>();
  for (const c of rows) groups.set(c.provider, [...(groups.get(c.provider) ?? []), c]);
  return [...groups].map(([provider, list]) => ({ provider, rows: list }));
}

export interface QuotaSummary {
  total: number;
  active: number;
  off: number;
  /** On, not failing and not at a limit: can take a request now. An account not reported yet counts. */
  ready: number;
  /** On, and under 30% left on its tightest limit or at its limit. */
  low: number;
  /** The next limit to start again, among the accounts that are on. */
  next: { at: number; account: string; window: string } | null;
}

export function summarize(rows: Connection[], reports: Record<string, QuotaReport | undefined>, now: number): QuotaSummary {
  const on = rows.filter((c) => !c.disabled);
  let ready = 0;
  let low = 0;
  let next: QuotaSummary["next"] = null;
  for (const c of on) {
    const r = reports[c.id];
    const left = leastLeft(r);
    const atLimit = r?.limit_reached === true || (left !== null && left <= EMPTY_AT);
    if (!r?.error && !atLimit) ready++;
    if (atLimit || (left !== null && left < LOW_AT)) low++;
    for (const w of r?.error ? [] : (r?.windows ?? [])) {
      if (w.reset_at !== null && w.reset_at > now && (next === null || w.reset_at < next.at)) next = { at: w.reset_at, account: c.name, window: w.name };
    }
  }
  return { total: rows.length, active: on.length, off: rows.length - on.length, ready, low, next };
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

/** Quota Tracker: each account's plan, what it has used and when its limits start again; a grid of account cards under each provider. */
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

  // `ask`: have the provider asked even where that costs a request (Groq); otherwise the gateway may answer from what it kept.
  const load = useCallback(async (id: string, ask = false) => {
    setLoading((s) => new Set(s).add(id));
    try {
      const r = await api<QuotaReport>(`/quota/${encodeURIComponent(id)}${ask ? "?refresh=1" : ""}`);
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

  // Each account's report once the list is in. "Refresh all" reloads the list with `askNext` set; auto-refresh does not.
  const askNext = useRef(false);
  useEffect(() => {
    if (list.status !== "ready") return;
    const ask = askNext.current;
    askNext.current = false;
    list.data.connections.forEach((c) => void load(c.id, ask));
  }, [list, load]);

  const refreshAll = useCallback(() => {
    askNext.current = true;
    reloadList();
  }, [reloadList]);
  const reloadRef = useRef(reloadList);
  reloadRef.current = reloadList;

  // Auto-refresh every minute while the tab is in view.
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reloadRef.current();
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
  const groups = useMemo(() => groupByProvider(shown), [shown]);
  const summary = useMemo(() => summarize(rows, reports, now), [rows, reports, now]);
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
  const others = list.status === "ready" ? (list.data.others ?? []) : [];

  if (list.status === "loading") return <Skeleton lines={4} announce labels={{ loading: t("loading") }} />;
  if (list.status === "error") return <Banner tone="danger" title={t("error.load")} action={<Button onClick={reloadList}>{t("common.retry")}</Button>} />;

  if (rows.length === 0) {
    return (
      <Stack gap={4}>
        <Card>
          <EmptyState size="center" icon="cloud" title={t("quota.empty")} hint={t("quota.emptyHint")} actions={<Button href="#/providers">{t("quota.connect")}</Button>} />
        </Card>
        <Others others={others} name={providerName} />
      </Stack>
    );
  }

  return (
    <Stack gap={4}>
      <Grid columns={{ base: 2, lg: 4 }} gap={3}>
        <StatTile labels={ui(lang).statTile} icon="accounts" label={t("quota.sum.accounts")} value={formatNumber(summary.total)} hint={t("quota.sum.accountsHint", { on: String(summary.active), off: String(summary.off) })} />
        <StatTile labels={ui(lang).statTile} icon="check-circle" label={t("quota.sum.ready")} value={formatNumber(summary.ready)} hint={t("quota.sum.readyHint")} />
        <StatTile labels={ui(lang).statTile} icon="alert" label={t("quota.sum.low")} value={formatNumber(summary.low)} hint={t("quota.sum.lowHint")} />
        <StatTile
          labels={ui(lang).statTile}
          icon="clock"
          label={t("quota.sum.next")}
          value={summary.next ? resetIn(summary.next.at, now) : "—"}
          hint={summary.next ? `${summary.next.account} · ${windowLabel(summary.next.window)}` : t("quota.sum.nextNone")}
        />
      </Grid>

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
        groups.map((g) => {
          const p = info.get(g.provider);
          const all = rows.filter((c) => c.provider === g.provider);
          const about = groupFacts(all, reports);
          const subtitle = [
            t("quota.group.accounts", { n: String(all.length), on: String(all.filter((c) => !c.disabled).length) }),
            about.noPlan ? t("quota.plan.unknown") : null,
            about.scope ? t("quota.scope", { model: about.scope }) : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Card
              key={g.provider}
              headingLevel={2}
              title={
                <span className="quota-group-title">
                  <Emblem name={p?.name ?? g.provider} text={p?.mark} color={p?.color} src={providerLogo(g.provider)} size="sm" />
                  <span>{p?.name ?? g.provider}</span>
                </span>
              }
              subtitle={subtitle}
            >
              <ul className="quota-rows">
                {g.rows.map((c) => (
                  <Account
                    key={c.id}
                    conn={c}
                    report={reports[c.id]}
                    loading={loading.has(c.id)}
                    hidden={hidden[c.provider] ?? []}
                    now={now}
                    lang={lang}
                    busy={busy}
                    said={about}
                    onRefresh={() => void load(c.id, true)}
                    onToggle={() => void setDisabled([c], !c.disabled)}
                    onHide={(name) => void toggleHidden(c.provider, name)}
                    onCredits={() => setCredits(c)}
                  />
                ))}
              </ul>
            </Card>
          );
        })
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

      <Others others={others} name={providerName} />

      {credits && (
        <CreditsDialog
          conn={credits}
          lang={lang}
          onClose={() => setCredits(null)}
          onReset={() => {
            setCredits(null);
            void load(credits.id, true);
          }}
        />
      )}
      <span className="x-sr-only" role="status">
        {loading.size > 0 ? t("loading") : ""}
      </span>
    </Stack>
  );
}

/**
 * What holds for every reported account of one provider, so the card says it once and not on each row: that the
 * provider reports no plan, and the model its limits are for.
 */
export function groupFacts(rows: Connection[], reports: Record<string, QuotaReport | undefined>): { noPlan: boolean; scope: string | null } {
  const known = rows.map((c) => reports[c.id]).filter((r): r is QuotaReport => r !== undefined && !r.error);
  const scopes = new Set(known.map((r) => r.scope ?? null));
  const scope = known.length > 0 && scopes.size === 1 ? [...scopes][0]! : null;
  return { noPlan: known.length > 0 && known.every((r) => planLabel(r.plan) === null), scope };
}

/** The connected providers this page cannot show: they report neither a plan nor a quota. */
function Others({ others, name }: { others: { provider: string; accounts: number }[]; name: (id: string) => string }) {
  if (others.length === 0) return null;
  return <p className="quota-others">{t("quota.others", { list: others.map((o) => `${name(o.provider)} (${o.accounts})`).join(", ") })}</p>;
}

/** Off, failing, at its limit, set aside by the gateway after a failure, or active: the first that holds. */
export function accountState(c: Connection, r: QuotaReport | undefined, now: number): { tone: "ok" | "warn" | "danger" | "neutral"; key: StringKey } {
  if (c.disabled) return { tone: "neutral", key: "quota.state.off" };
  if (r?.error) return { tone: "danger", key: "quota.state.error" };
  if (r?.limit_reached) return { tone: "danger", key: "quota.state.limit" };
  if (c.cooldown_until > now) return { tone: "warn", key: "quota.state.cooling" };
  return { tone: "ok", key: "quota.state.active" };
}

function Account(props: {
  conn: Connection;
  report: QuotaReport | undefined;
  loading: boolean;
  hidden: string[];
  now: number;
  lang: Lang;
  busy: boolean;
  /** What the provider's card already says for all its accounts. */
  said: { noPlan: boolean; scope: string | null };
  onRefresh: () => void;
  onToggle: () => void;
  onHide: (name: string) => void;
  onCredits: () => void;
}) {
  const { conn: c, report: r, loading, hidden, now, lang } = props;
  const state = accountState(c, r, now);
  const windows = (r?.windows ?? []).filter((w) => !hidden.includes(w.name));
  const plan = planLabel(r?.plan);
  const seat = r?.seat ? t(r.seat === "premium" ? "quota.seat.premium" : "quota.seat.standard") : null;
  const known = r !== undefined && !r.error;
  // Said on the row only when the provider's card does not say it for all its accounts.
  const noPlanNote = plan === null && known && !props.said.noPlan;
  const notes = [
    r?.scope && r.scope !== props.said.scope ? t("quota.scope", { model: r.scope }) : null,
    known && r.checked_at !== undefined && now - r.checked_at > STALE_S ? t("quota.checked", { when: ago(r.checked_at, now) }) : null,
    known && r.reset_credits !== null && r.reset_credits > 0 ? t("quota.credits.count", { n: String(r.reset_credits) }) : null,
    !c.disabled && c.cooldown_until > now ? t("quota.cooling", { when: resetIn(c.cooldown_until, now) }) + (c.last_error ? `: ${c.last_error}` : "") : null,
  ].filter((x): x is string => x !== null);
  return (
    <li className="quota-row" data-off={c.disabled ? "" : undefined}>
      <div className="quota-who">
        <span className="quota-who-name">{c.name}</span>
        <span className="quota-who-meta">
          <StatusDot tone={state.tone} label={t(state.key)} />
          {plan && <Tag>{plan}</Tag>}
          {noPlanNote && <span>{t("quota.plan.unknown")}</span>}
          {seat && <span>{seat}</span>}
          {c.hint && <span>{t("providers.keyEnds", { hint: c.hint })}</span>}
        </span>
      </div>
      <div className="quota-body">
        {!r && loading ? (
          <Skeleton lines={2} labels={{ loading: t("loading") }} />
        ) : r?.error ? (
          <Banner tone="danger" title={r.error.message} />
        ) : r?.message ? (
          <p className="quota-note">{r.message}</p>
        ) : windows.length === 0 ? (
          <p className="quota-note">{r && r.windows.length > 0 ? t("quota.allHidden") : plan ? t("quota.planOnly") : t("quota.noWindows")}</p>
        ) : (
          <ul className="quota-tiles">
            {windows.map((w) => {
              const label = windowLabel(w.name);
              const cycle = cycleLabel(w.period_seconds);
              // "Weekly" under a bar already named Weekly says nothing.
              const meta = [w.kind === "count" || w.kind === "spend" ? windowValue(w) : null, cycle === label ? null : cycle].filter(Boolean).join(" · ");
              return (
                <li key={w.name} className="quota-tile">
                  <span className="quota-tile-bar">
                    <Meter fill label={label} value={usedPercent(w)} tone={quotaTone(w.remaining_percent)} valueText={meterText(w)} />
                    <span className="quota-tile-hide">
                      <IconButton icon="eye-off" size="sm" label={t("quota.hide", { name: label })} onClick={() => props.onHide(w.name)} />
                    </span>
                  </span>
                  <span className="quota-tile-meta">
                    {meta && <span>{sentence(meta)}</span>}
                    {w.reset_at !== null && w.reset_at > now && <span title={formatDate(w.reset_at, lang)}>{t("quota.resets", { when: resetIn(w.reset_at, now) })}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {notes.length > 0 && <p className="quota-note">{sentence(notes.join(" · "))}</p>}
      </div>
      <span className="quota-row-end">
        {c.provider === "codex" && <IconButton icon="restore" label={t("quota.credits.open", { name: c.name })} disabled={props.busy} onClick={props.onCredits} />}
        <IconButton icon="refresh" label={t("quota.refreshOne", { name: c.name })} disabled={loading} onClick={props.onRefresh} />
        <Switch aria-label={t("quota.toggle", { name: c.name })} checked={!c.disabled} disabled={props.busy} onChange={props.onToggle} />
      </span>
    </li>
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
