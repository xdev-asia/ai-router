import { useEffect, useState, type ReactNode } from "react";
import {
  Banner,
  BarChart,
  BrandMark,
  Button,
  Card,
  DataTable,
  Emblem,
  EmptyState,
  Field,
  FlowMap,
  Grid,
  GridItem,
  List,
  ListRow,
  Meter,
  Segmented,
  Select,
  Skeleton,
  Stack,
  StatTile,
  StatusDot,
  Tabs,
  TimeSeriesChart,
  sortTableRows,
  type BarDatum,
  type DataTableColumn,
  type FlowMapNode,
  type MeterTone,
  type TableSort,
  type TimeSeriesTick,
} from "@xdev-asia/ui";
import { api, useLoad, type Connection, type Provider, type System, type UsageBucket, type UsageChart, type UsagePeriod, type UsageRequest, type UsageSummary, type UsageTokens } from "../api";
import { formatNumber, t, useLang, type Lang, type StringKey } from "../i18n";
import { clientLogo, providerLogo } from "../provider-logos";
import { ui } from "../ui-labels";
import { useHashParams } from "../url-state";

const PERIODS: UsagePeriod[] = ["today", "24h", "7d", "30d", "60d", "all"];
/** Rows in the recent list beside the router map; the Details tab has the rest. */
const RECENT_ROWS = 12;
/** Bars in the top models chart; the breakdown table has every model. */
const TOP_MODELS = 5;
/** Rows the Details tab asks for at a time. */
const PAGE = 100;
/** Boxes a side of the router map shows; past that the quietest fold into one "N others" box. */
const MAP_SIDE = 8;

export type Metric = "tokens" | "requests" | "cost" | "errors";
type Breakdown = "model" | "provider" | "account" | "key";
type StatusFilter = "" | "ok" | "error";

/** What the Details tab narrows by. Empty strings mean "any". */
export interface RequestFilters {
  provider: string;
  model: string;
  system: string;
  status: StatusFilter;
  from: string;
  to: string;
}
const NO_FILTERS: RequestFilters = { provider: "", model: "", system: "", status: "", from: "", to: "" };

/** "~$3.60": a dollar estimate, never an exact bill. A dash when nothing in the group has a price. */
export const formatCost = (cost: number | null): string => (cost === null ? "—" : `~$${cost.toFixed(2)}`);

const locale = (lang: Lang) => (lang === "vi" ? "vi-VN" : "en-US");

const formatTime = (at: number, lang: Lang) =>
  new Date(at * 1000).toLocaleString(locale(lang), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** "3 min ago", in the owner's language; "now" under a minute. */
export function formatAgo(at: number, lang: Lang, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - at));
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto", style: "short" });
  if (s < 60) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86_400) return rtf.format(-Math.floor(s / 3600), "hour");
  return rtf.format(-Math.floor(s / 86_400), "day");
}

/** "Nov 14, 06:30 PM": a group's last request, to the minute. */
const formatDay = (at: number, lang: Lang) => new Date(at * 1000).toLocaleString(locale(lang), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** "12.4M": a short form for the big totals; the tables keep the whole number. */
const formatCompact = (n: number, lang: Lang) => new Intl.NumberFormat(locale(lang), { notation: "compact", maximumFractionDigits: 1 }).format(n);

const formatMs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : `${formatNumber(ms)} ms`);

/** The caller's offset in minutes east of UTC, so "today" and the chart's days follow the owner's calendar. */
const tzMinutes = () => -new Date().getTimezoneOffset();

/** Every token a group counted: input, output and both cache kinds. */
export const allTokens = (r: UsageTokens): number => r.input_tokens + r.output_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens;

/** Share of prompt tokens served from the cache, 0-100; null when the group read no prompt at all. */
export function cacheRate(r: UsageTokens): number | null {
  const prompt = r.input_tokens + r.cache_read_input_tokens;
  return prompt > 0 ? (r.cache_read_input_tokens / prompt) * 100 : null;
}

/** Share of requests answered below 400, 0-100; null with no requests. */
export function successRate(r: UsageTokens): number | null {
  return r.requests > 0 ? ((r.requests - (r.errors ?? 0)) / r.requests) * 100 : null;
}

/** Relative change in percent; null when there is nothing to compare with. */
export function percentChange(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now === null || now === undefined || before === null || before === undefined || before === 0) return null;
  return ((now - before) / before) * 100;
}

/** "+12%", "−8%", "0%": one decimal below 10, none above. */
export function formatChange(p: number, unit = "%"): string {
  const abs = Math.abs(p);
  const n = abs < 10 ? Math.round(abs * 10) / 10 : Math.round(abs);
  const sign = n === 0 ? "" : p > 0 ? "+" : "−";
  return `${sign}${n}${unit}`;
}

/** A table as CSV text: every field quoted when it holds a comma, a quote or a line break. */
export function toCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  const field = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(field).join(",")).join("\r\n") + "\r\n";
}

function downloadCsv(name: string, rows: readonly (readonly (string | number | null)[])[]) {
  const blob = new Blob([toCsv(rows)], { type: "text/csv" });
  if (typeof URL.createObjectURL !== "function") return;
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}

/** A bucket's value under a measure; null (a gap, not zero) when it has requests but no price. */
export function bucketValue(b: UsageBucket, metric: Metric): number | null {
  return metric === "tokens" ? b.tokens : metric === "requests" ? b.requests : metric === "errors" ? (b.errors ?? 0) : b.cost;
}

function formatMetric(v: number | null, metric: Metric): string {
  if (metric === "cost") return v === null ? t("usage.chart.noPrice") : formatCost(v);
  return formatNumber(v ?? 0);
}

/** About six labels along the time axis: hours for hourly buckets, dates for daily ones. */
export function chartTicks(buckets: readonly UsageBucket[], step: number, lang: Lang): TimeSeriesTick[] {
  const every = Math.max(1, Math.ceil(buckets.length / 6));
  const fmt: Intl.DateTimeFormatOptions = step < 86_400 ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" };
  const out: TimeSeriesTick[] = [];
  for (let i = 0; i < buckets.length; i += every) out.push({ index: i, label: new Date(buckets[i].t * 1000).toLocaleString(locale(lang), fmt) });
  return out;
}

/** Below 95% of requests answered is a problem; below 99% is worth a look. */
const successTone = (rate: number): MeterTone => (rate >= 99 ? "ok" : rate >= 95 ? "warn" : "danger");

/** One end of the router map: a system on the left, a provider on the right, with its requests in the period. */
export interface RouteEnd {
  id: string;
  name: string;
  requests: number;
  errors: number;
  src?: string | null;
  color?: string | null;
  text?: string;
}

/**
 * The two sides of the router map. Systems: every system, and any in the period's rows that is gone since.
 * Providers: every provider with an account, and any the period's rows name.
 */
export function routerEnds(data: UsageSummary, providers: Provider[], connections: Connection[], systems: System[]): { sources: RouteEnd[]; nodes: RouteEnd[] } {
  const sources = new Map<string, RouteEnd>(systems.map((s) => [s.id, { id: s.id, name: s.name, requests: 0, errors: 0, src: clientLogo(s.name) }]));
  for (const r of data.by_system) {
    const name = sources.get(r.system_id)?.name ?? r.name ?? r.system_id;
    sources.set(r.system_id, { id: r.system_id, name, requests: r.requests, errors: r.errors ?? 0, src: clientLogo(name) });
  }
  const meta = new Map(providers.map((p) => [p.id, p]));
  const end = (id: string): RouteEnd => {
    const p = meta.get(id);
    return { id, name: p?.name ?? id, requests: 0, errors: 0, src: providerLogo(id), color: p?.color ?? null, text: p?.mark };
  };
  const nodes = new Map<string, RouteEnd>();
  for (const c of connections) if (!nodes.has(c.provider)) nodes.set(c.provider, end(c.provider));
  for (const r of data.by_provider) nodes.set(r.provider, { ...(nodes.get(r.provider) ?? end(r.provider)), requests: r.requests, errors: r.errors ?? 0 });
  return { sources: [...sources.values()], nodes: [...nodes.values()] };
}

/**
 * One side as map boxes, by name. More than `limit` keeps the busiest and folds the rest into one "N others" box,
 * last. A line's weight is its requests against the busiest box on the side; its tone follows the success rate.
 */
export function routeSide(ends: readonly RouteEnd[], limit = MAP_SIDE): FlowMapNode[] {
  const ranked = [...ends].sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
  const shown = ranked.length > limit ? ranked.slice(0, limit - 1) : ranked;
  const rest = ranked.slice(shown.length);
  const folded: RouteEnd[] = rest.length
    ? [{ id: "others:", name: t("usage.route.others", { n: formatNumber(rest.length) }), text: "+", requests: rest.reduce((n, e) => n + e.requests, 0), errors: rest.reduce((n, e) => n + e.errors, 0) }]
    : [];
  const all = [...shown.sort((a, b) => a.name.localeCompare(b.name)), ...folded];
  const max = Math.max(1, ...all.map((e) => e.requests));
  return all.map((e) => {
    const rate = e.requests > 0 ? ((e.requests - e.errors) / e.requests) * 100 : null;
    const n = formatNumber(e.requests);
    return {
      id: e.id,
      name: e.name,
      src: e.src,
      color: e.color,
      text: e.text,
      active: e.requests > 0,
      weight: e.requests / max,
      tone: rate === null || rate >= 99 ? undefined : rate >= 95 ? "warn" : "danger",
      detail: e.requests === 0 ? t("usage.route.idle") : e.errors > 0 ? t("usage.route.failed", { n, failed: formatNumber(e.errors) }) : t("usage.route.requests", { n }),
    };
  });
}

function Status({ code }: { code: number }) {
  return <StatusDot tone={code < 400 ? "ok" : code === 429 || code >= 500 ? "warn" : "danger"} label={String(code)} />;
}

/** The tab and the period live in the address (`#/usage?tab=details`, `#/usage?period=7d`). */
const TAB_DEFAULT = { tab: "overview" };
const TAB_ALLOWED = { tab: ["overview", "details"] };
const PERIOD_DEFAULT = { period: "24h" };
const PERIOD_ALLOWED = { period: PERIODS };

/** Usage: an Overview of a period and a Details list of single requests. A breakdown row opens Details narrowed to it. */
export function Usage() {
  useLang();
  const [{ tab }, setParams] = useHashParams("#/usage", TAB_DEFAULT, TAB_ALLOWED);
  const setTab = (id: string) => setParams({ tab: id });
  const [filters, setFilters] = useState<RequestFilters>(NO_FILTERS);
  const openDetails = (next: Partial<RequestFilters>) => {
    setFilters({ ...NO_FILTERS, ...next });
    setTab("details");
  };
  return (
    <Stack gap={4}>
      <Tabs
        variant="pill"
        label={t("usage.title")}
        value={tab}
        onChange={setTab}
        items={[
          { id: "overview", label: t("usage.tab.overview") },
          { id: "details", label: t("usage.tab.details") },
        ]}
      />
      {tab === "details" ? <Details filters={filters} onChange={setFilters} /> : <Overview onOpenDetails={openDetails} />}
    </Stack>
  );
}

function MetricPicker({ value, onChange, metrics }: { value: Metric; onChange: (m: Metric) => void; metrics: Metric[] }) {
  return (
    <Segmented
      label={t("usage.metric")}
      value={value}
      onChange={(v) => onChange(v as Metric)}
      options={metrics.map((m) => ({ value: m, label: t(`usage.metric.${m}` as StringKey) }))}
    />
  );
}

/** The change beside a total. `upIs` says whether a rise is good news; rates move in points, the rest in percent. */
function delta(now: number | null, before: number | null, upIs: "good" | "bad" | "neutral", points = false) {
  const p = points ? (now === null || before === null ? null : now - before) : percentChange(now, before);
  if (p === null) return {};
  const text = points ? t("usage.points", { n: formatChange(p, "") }) : formatChange(p);
  const flat = Math.abs(p) < 0.05;
  const tone = flat || upIs === "neutral" ? "neutral" : (p > 0) === (upIs === "good") ? "good" : "bad";
  return { delta: text, deltaTrend: flat ? undefined : p > 0 ? ("up" as const) : ("down" as const), deltaTone: tone as "good" | "bad" | "neutral", hint: t("usage.vsPrevious") };
}

function Totals({ data, loading }: { data: UsageSummary | null; loading: boolean }) {
  const [lang] = useLang();
  const labels = ui(lang).statTile;
  const now = data?.totals;
  const before = data?.previous ?? null;
  const rate = now ? successRate(now) : null;
  const cache = now ? cacheRate(now) : null;
  const pct = (v: number | null) => (v === null ? "—" : `${formatNumber(Math.round(v * 10) / 10)}%`);
  const common = { loading, labels };
  return (
    <Grid columns={{ base: 1, sm: 2, md: 3, "2xl": 6 }} gap={3}>
      <StatTile {...common} label={t("usage.requests")} value={formatNumber(now?.requests ?? 0)} {...delta(now?.requests ?? null, before?.requests ?? null, "neutral")} />
      <StatTile
        {...common}
        label={t("usage.tokens")}
        value={formatCompact(now ? allTokens(now) : 0, lang)}
        {...delta(now ? allTokens(now) : null, before ? allTokens(before) : null, "neutral")}
      >
        {now && <span className="muted">{t("usage.tokensSplit", { input: formatCompact(now.input_tokens, lang), output: formatCompact(now.output_tokens, lang) })}</span>}
      </StatTile>
      <StatTile {...common} label={t("usage.cost")} value={formatCost(now?.cost ?? null)} {...delta(now?.cost ?? null, before?.cost ?? null, "neutral")}>
        <span className="muted">{t("usage.costHint")}</span>
      </StatTile>
      <StatTile {...common} label={t("usage.cacheRate")} value={pct(cache)} {...delta(cache, before ? cacheRate(before) : null, "good", true)}>
        {cache !== null && now && <Meter fill value={cache} valueText={t("usage.cacheRateHint", { n: formatCompact(now.cache_read_input_tokens, lang) })} />}
      </StatTile>
      <StatTile {...common} label={t("usage.successRate")} value={pct(rate)} {...delta(rate, before ? successRate(before) : null, "good", true)}>
        {rate !== null && now && <Meter fill value={rate} tone={successTone(rate)} valueText={t("usage.errorsN", { n: formatNumber(now.errors ?? 0) })} />}
      </StatTile>
      <StatTile {...common} label={t("usage.avgLatency")} value={formatMs(now?.latency_ms)} {...delta(now?.latency_ms ?? null, before?.latency_ms ?? null, "bad")} />
    </Grid>
  );
}

/** The period as a route: systems send requests into the router, which spreads them over the providers. */
function RouterMap({ data, loading, providers }: { data: UsageSummary | null; loading: boolean; providers: Provider[] | null }) {
  const [connections] = useLoad<Connection[]>("/connections");
  const [systems] = useLoad<System[]>("/systems");
  // An account or system list that failed to load only hides the idle boxes; the period's rows still draw.
  const waiting = loading || providers === null || connections.status === "loading" || systems.status === "loading";
  const ends = data && !waiting ? routerEnds(data, providers, connections.status === "ready" ? connections.data : [], systems.status === "ready" ? systems.data : []) : null;
  const totals = data?.totals;
  return (
    <Card title={t("usage.route.title")} subtitle={t("usage.route.subtitle")} headingLevel={2}>
      {waiting && <Skeleton lines={6} announce labels={{ loading: t("loading") }} />}
      {ends && ends.sources.length + ends.nodes.length === 0 && <EmptyState size="inline" icon="activity" title={t("usage.route.empty")} />}
      {ends && totals && ends.sources.length + ends.nodes.length > 0 && (
        <FlowMap
          className="usage-router-map"
          label={t("usage.route.label")}
          labels={{ zoomIn: t("usage.route.zoomIn"), zoomOut: t("usage.route.zoomOut"), fit: t("usage.route.fit"), controls: t("usage.route.controls") }}
          hub={{
            name: t("app.name"),
            mark: <BrandMark variant="tile" size={28} />,
            detail: t("usage.route.hub", { n: formatNumber(totals.requests), ms: formatMs(totals.latency_ms) }),
          }}
          sources={routeSide(ends.sources)}
          nodes={routeSide(ends.nodes)}
        />
      )}
    </Card>
  );
}

/** The period's last requests as a feed beside the map: the provider's mark, the model, how long ago, latency and status. */
function RecentFeed({ rows, loading, providerName, empty, onViewAll }: { rows: UsageRequest[]; loading: boolean; providerName: Map<string, string>; empty: ReactNode; onViewAll: () => void }) {
  const [lang] = useLang();
  return (
    <Card title={t("usage.recent")} headingLevel={2} actions={<Button size="sm" onClick={onViewAll}>{t("usage.viewAll")}</Button>}>
      {loading && <Skeleton lines={6} announce labels={{ loading: t("loading") }} />}
      {!loading && rows.length === 0 && empty}
      {!loading && rows.length > 0 && (
        <List className="usage-recent" aria-label={t("usage.recent")}>
          {rows.map((r) => {
            const name = providerName.get(r.provider) ?? r.provider;
            return (
              <ListRow
                as="li"
                key={r.id}
                leading={<Emblem name={name} src={providerLogo(r.provider)} size="sm" />}
                title={r.model ?? "—"}
                meta={
                  <>
                    {name} · <time dateTime={new Date(r.at * 1000).toISOString()} title={formatTime(r.at, lang)}>{formatAgo(r.at, lang)}</time>
                  </>
                }
                trailing={
                  <span className="usage-recent-end">
                    <span className="muted">{formatMs(r.latency_ms)}</span>
                    <Status code={r.status} />
                  </span>
                }
              />
            );
          })}
        </List>
      )}
    </Card>
  );
}

function Overview({ onOpenDetails }: { onOpenDetails: (f: Partial<RequestFilters>) => void }) {
  const [providers] = useLoad<Provider[]>("/providers");
  const [params, setParams] = useHashParams("#/usage", PERIOD_DEFAULT, PERIOD_ALLOWED);
  const period = params.period as UsagePeriod;
  const setPeriod = (p: UsagePeriod) => setParams({ period: p });
  // "today" starts at the owner's midnight; the rolling periods need no offset.
  const [report, reload] = useLoad<UsageSummary>(`/usage/summary?period=${period}${period === "today" ? `&tz=${tzMinutes()}` : ""}`);
  const loading = report.status === "loading";
  const data = report.status === "ready" ? report.data : null;
  const totals = data?.totals;
  const providerName = new Map((providers.status === "ready" ? providers.data : []).map((p) => [p.id, p.name]));
  const empty = <EmptyState size="inline" icon="activity" title={t("usage.noRequests")} />;

  return (
    <Stack gap={4}>
      <Segmented label={t("usage.period")} value={period} onChange={(v) => setPeriod(v as UsagePeriod)} options={PERIODS.map((p) => ({ value: p, label: t(`usage.period.${p}` as StringKey) }))} />
      {report.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {/* A failed summary hides the totals and charts built from it: zeros there would read as a quiet period. */}
      {report.status !== "error" && <Totals data={data} loading={loading} />}
      {totals && totals.unpriced_requests > 0 && (
        <Banner tone="info" title={t("usage.unpriced", { n: formatNumber(totals.unpriced_requests) })} action={<Button href="#/pricing">{t("usage.setPrices")}</Button>} />
      )}
      {report.status !== "error" && (
        <Grid columns={{ base: 1, xl: 3 }} gap={3}>
          <GridItem span={{ base: 1, xl: 2 }}>
            <RouterMap data={data} loading={loading} providers={providers.status === "ready" ? providers.data : providers.status === "error" ? [] : null} />
          </GridItem>
          <RecentFeed rows={(data?.recent ?? []).slice(0, RECENT_ROWS)} loading={loading} providerName={providerName} empty={empty} onViewAll={() => onOpenDetails({})} />
        </Grid>
      )}
      <OverTime period={period} />
      {report.status !== "error" && (
        <>
          <Grid columns={{ base: 1, lg: 2 }} gap={3}>
            <BarsCard
              title={t("usage.byProvider")}
              chartLabel={(m) => t("usage.bars.byProvider", { metric: t(`usage.metric.${m}` as StringKey) })}
              rows={(data?.by_provider ?? []).map((r) => ({ key: r.provider, label: providerName.get(r.provider) ?? r.provider, row: r }))}
              loading={loading}
              empty={empty}
            />
            <BarsCard
              title={t("usage.topModels")}
              chartLabel={(m) => t("usage.bars.topModels", { metric: t(`usage.metric.${m}` as StringKey) })}
              rows={(data?.by_model ?? []).map((r) => ({ key: `${r.provider}/${r.model ?? ""}`, label: r.model ?? "—", row: r }))}
              limit={TOP_MODELS}
              loading={loading}
              empty={empty}
            />
          </Grid>
          <BreakdownCard data={data} loading={loading} providerName={providerName} empty={empty} period={period} onOpenDetails={onOpenDetails} />
        </>
      )}
    </Stack>
  );
}

/** The usage chart: one series over the period, as tokens, requests, cost or errors. */
function OverTime({ period }: { period: UsagePeriod }) {
  const [lang] = useLang();
  const [metric, setMetric] = useState<Metric>("tokens");
  const [chart, reload] = useLoad<UsageChart>(`/usage/chart?period=${period}&tz=${tzMinutes()}`);
  const data = chart.status === "ready" ? chart.data : null;
  const hourly = (data?.step ?? 3600) < 86_400;
  const pointTime: Intl.DateTimeFormatOptions = hourly ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" };
  const metricName = t(`usage.metric.${metric}` as StringKey);
  const label = t(hourly ? "usage.chart.perHour" : "usage.chart.perDay", { metric: metricName });
  const quiet = data !== null && data.buckets.every((b) => b.requests === 0);
  const max = data ? data.buckets.reduce((m, b) => Math.max(m, bucketValue(b, metric) ?? 0), 0) : 0;

  return (
    <Card title={t("usage.chart.title")} headingLevel={2} actions={<MetricPicker value={metric} onChange={setMetric} metrics={["tokens", "requests", "cost", "errors"]} />}>
      {chart.status === "loading" && <Skeleton lines={4} announce labels={{ loading: t("loading") }} />}
      {chart.status === "error" && <Banner tone="danger" title={t("usage.chart.error")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {data && quiet && <EmptyState size="inline" icon="activity" title={t("usage.noRequests")} />}
      {data && !quiet && (
        <TimeSeriesChart
          label={label}
          points={data.buckets.map((b) => ({
            key: String(b.t),
            value: bucketValue(b, metric),
            label: t("usage.chart.point", { time: new Date(b.t * 1000).toLocaleString(locale(lang), pointTime), value: formatMetric(bucketValue(b, metric), metric) }),
          }))}
          ticks={chartTicks(data.buckets, data.step, lang)}
          maxLabel={formatMetric(max, metric)}
          zeroLabel={metric === "cost" ? "$0" : "0"}
        />
      )}
    </Card>
  );
}

/** A ranked bar chart of groups (providers, models), by tokens or requests, largest first. */
function BarsCard({
  title,
  chartLabel,
  rows,
  limit,
  loading,
  empty,
}: {
  title: string;
  chartLabel: (m: Metric) => string;
  rows: { key: string; label: string; row: UsageTokens }[];
  limit?: number;
  loading: boolean;
  empty: ReactNode;
}) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const value = (r: UsageTokens) => (metric === "requests" ? r.requests : allTokens(r));
  const bars: BarDatum[] = rows
    .map((r) => ({ key: r.key, label: r.label, value: value(r.row), valueLabel: formatNumber(value(r.row)) }))
    .filter((b) => b.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit ?? rows.length);
  return (
    <Card title={title} headingLevel={2} actions={<MetricPicker value={metric} onChange={setMetric} metrics={["tokens", "requests"]} />}>
      {loading ? <Skeleton lines={3} announce labels={{ loading: t("loading") }} /> : bars.length === 0 ? empty : <BarChart label={chartLabel(metric)} bars={bars} />}
    </Card>
  );
}

/** One breakdown row whatever the grouping: its name, where it leads in Details, and its numbers. */
interface GroupRow extends UsageTokens {
  key: string;
  name: string;
  provider: string | null;
  last_at: number | null;
  /** The Details filters that show this group's requests; null when Details cannot narrow to it (an account). */
  drill: Partial<RequestFilters> | null;
}

export function groupRows(data: UsageSummary | null, group: Breakdown, providerName: ReadonlyMap<string, string>): GroupRow[] {
  if (!data) return [];
  const pname = (id: string) => providerName.get(id) ?? id;
  if (group === "model")
    return data.by_model.map((r) => ({ ...r, key: `${r.provider}/${r.model ?? ""}`, name: r.model ?? "—", last_at: r.last_at ?? null, drill: { provider: r.provider, model: r.model ?? "" } }));
  if (group === "provider") return data.by_provider.map((r) => ({ ...r, key: r.provider, name: pname(r.provider), provider: null, last_at: r.last_at ?? null, drill: { provider: r.provider } }));
  if (group === "account")
    return (data.by_connection ?? []).map((r) => ({
      ...r,
      key: `${r.provider}/${r.connection_id ?? ""}`,
      // The account's name and the key's last characters only; the key itself never reaches the console.
      name: r.connection_id === null ? t("usage.noAccount") : [r.name, r.hint].filter(Boolean).join(" · ") || r.connection_id,
      drill: null,
    }));
  return data.by_system.map((r) => ({ ...r, key: r.system_id, name: r.name ?? r.system_id, provider: null, last_at: r.last_at ?? null, drill: { system: r.system_id } }));
}

/** The value a breakdown column sorts by. */
function sortValue(r: GroupRow, key: string): string | number {
  switch (key) {
    case "name":
      return r.name;
    case "requests":
      return r.requests;
    case "tokens":
    case "share":
      return allTokens(r);
    case "cacheRate":
      return cacheRate(r) ?? -1;
    case "success":
      return successRate(r) ?? -1;
    case "latency":
      return r.latency_ms ?? -1;
    case "cost":
      return r.cost ?? -1;
    case "lastUsed":
      return r.last_at ?? 0;
    default:
      return 0;
  }
}

/** The "Usage by Model / Provider / Account / API Key" table: what each group used, how well it went, and its share. */
function BreakdownCard({
  data,
  loading,
  providerName,
  empty,
  period,
  onOpenDetails,
}: {
  data: UsageSummary | null;
  loading: boolean;
  providerName: ReadonlyMap<string, string>;
  empty: ReactNode;
  period: UsagePeriod;
  onOpenDetails: (f: Partial<RequestFilters>) => void;
}) {
  const [lang] = useLang();
  const [group, setGroup] = useState<Breakdown>("model");
  const [sort, setSort] = useState<TableSort | null>({ key: "tokens", dir: "desc" });
  const groupName = t(`usage.breakdown.${group}` as StringKey);
  const rows = groupRows(data, group, providerName);
  const total = rows.reduce((n, r) => n + allTokens(r), 0);
  const share = (r: GroupRow) => (total > 0 ? (allTokens(r) / total) * 100 : 0);
  const pct = (v: number | null) => (v === null ? "—" : `${formatNumber(Math.round(v * 10) / 10)}%`);
  const nameHeader = t(group === "model" ? "usage.col.model" : group === "provider" ? "usage.col.provider" : group === "account" ? "usage.col.account" : "usage.col.key");

  const columns: DataTableColumn<GroupRow>[] = [
    { key: "name", header: nameHeader, sortable: true, mono: group === "model", cell: (r) => r.name },
    ...(group === "model" || group === "account"
      ? [{ key: "provider", width: "min" as const, header: t("usage.col.provider"), hideNarrow: true, cell: (r: GroupRow) => (r.provider ? (providerName.get(r.provider) ?? r.provider) : "—") }]
      : []),
    { key: "requests", width: "min", header: t("usage.requests"), align: "end", sortable: true, cell: (r) => formatNumber(r.requests) },
    { key: "tokens", width: "min", header: t("usage.col.tokens"), align: "end", sortable: true, cell: (r) => formatNumber(allTokens(r)) },
    { key: "cacheRate", width: "min", header: t("usage.col.cacheRate"), align: "end", sortable: true, hideNarrow: true, cell: (r) => pct(cacheRate(r)) },
    {
      key: "success",
      width: "min",
      header: t("usage.col.success"),
      align: "end",
      sortable: true,
      hideNarrow: true,
      cell: (r) => {
        const rate = successRate(r);
        return rate === null ? "—" : <StatusDot tone={successTone(rate)} label={pct(rate)} />;
      },
    },
    { key: "latency", width: "min", header: t("usage.col.latency"), align: "end", sortable: true, hideNarrow: true, cell: (r) => formatMs(r.latency_ms) },
    { key: "cost", width: "min", header: t("usage.col.cost"), align: "end", sortable: true, cell: (r) => formatCost(r.cost) },
    { key: "share", width: "min", header: t("usage.col.share"), sortable: true, hideNarrow: true, cell: (r) => <Meter value={share(r)} /> },
    { key: "lastUsed", width: "min", header: t("usage.col.lastUsed"), sortable: true, hideNarrow: true, cell: (r) => (r.last_at ? formatDay(r.last_at, lang) : "—") },
    {
      key: "actions",
      header: <span className="x-sr-only">{t("usage.col.actions")}</span>,
      label: t("usage.col.actions"),
      width: "min",
      sticky: "end",
      cell: (r) =>
        r.drill ? (
          <Button size="sm" variant="ghost" icon="arrow-right" aria-label={t("usage.viewRequestsFor", { name: r.name })} onClick={() => onOpenDetails(r.drill ?? {})}>
            {t("usage.viewRequests")}
          </Button>
        ) : null,
    },
  ];

  const exportCsv = () =>
    downloadCsv(`usage-${group}-${period}.csv`, [
      [nameHeader, t("usage.col.provider"), t("usage.requests"), t("usage.input"), t("usage.output"), t("usage.cacheWrite"), t("usage.cacheRead"), t("usage.metric.errors"), t("usage.col.latency"), t("usage.col.cost")],
      ...rows.map((r) => [
        r.name,
        r.provider ?? "",
        r.requests,
        r.input_tokens,
        r.output_tokens,
        r.cache_creation_input_tokens,
        r.cache_read_input_tokens,
        r.errors ?? 0,
        r.latency_ms ?? null,
        r.cost === null ? null : Number(r.cost.toFixed(4)),
      ]),
    ]);

  return (
    <Card
      title={t("usage.breakdown")}
      headingLevel={2}
      flush
      actions={
        <Stack direction="row" gap={2}>
          <Segmented
            label={t("usage.breakdown.by")}
            value={group}
            onChange={(v) => setGroup(v as Breakdown)}
            options={(["model", "provider", "account", "key"] as const).map((g) => ({ value: g, label: t(`usage.breakdown.${g}` as StringKey) }))}
          />
          <Button size="sm" icon="download" onClick={exportCsv} disabled={rows.length === 0}>
            {t("usage.export")}
          </Button>
        </Stack>
      }
    >
      <DataTable<GroupRow>
        caption={t("usage.breakdown.caption", { group: groupName })}
        columns={columns}
        rows={sortTableRows(rows, sort, sortValue)}
        rowKey={(r) => r.key}
        sort={sort}
        onSortChange={setSort}
        loading={loading}
        labels={ui(lang).dataTable}
        empty={empty}
      />
    </Card>
  );
}

function RequestTable({ caption, rows, loading, empty }: { caption: string; rows: UsageRequest[]; loading: boolean; empty: ReactNode }) {
  const [lang] = useLang();
  const columns: DataTableColumn<UsageRequest>[] = [
    { key: "time", header: t("usage.col.time"), cell: (r) => formatTime(r.at, lang) },
    { key: "model", header: t("usage.col.model"), mono: true, cell: (r) => r.model ?? "—" },
    { key: "provider", header: t("usage.col.provider"), mono: true, hideNarrow: true, cell: (r) => r.provider },
    { key: "system", header: t("usage.col.system"), mono: true, hideNarrow: true, cell: (r) => r.system_id },
    { key: "status", header: t("usage.col.status"), cell: (r) => <Status code={r.status} /> },
    { key: "input", header: t("usage.input"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.input_tokens) },
    { key: "cacheRead", header: t("usage.cacheRead"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_read_input_tokens) },
    { key: "cacheWrite", header: t("usage.cacheWrite"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_creation_input_tokens) },
    { key: "output", header: t("usage.output"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.output_tokens) },
    { key: "latency", header: t("usage.col.latency"), align: "end", cell: (r) => formatMs(r.latency_ms) },
  ];
  return <DataTable caption={caption} columns={columns} rows={rows} rowKey={(r) => String(r.id)} loading={loading} labels={ui(lang).dataTable} empty={empty} />;
}

/** datetime-local value ("2026-11-12T08:30") to unix seconds; null when empty or unreadable. */
function toUnix(local: string): number | null {
  const ms = local ? Date.parse(local) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The request list's query for a set of filters, without `before`. */
export function requestQuery(f: RequestFilters): string {
  const query = [`limit=${PAGE}`];
  const add = (name: string, value: string | number | null) => {
    if (value !== null && value !== "") query.push(`${name}=${encodeURIComponent(value)}`);
  };
  add("provider", f.provider);
  add("model", f.model.trim());
  add("system", f.system);
  add("status", f.status);
  add("from", toUnix(f.from));
  add("to", toUnix(f.to));
  return query.join("&");
}

/** One row per request, newest first, narrowed by provider, model, key, outcome and time; more pages on request. */
function Details({ filters, onChange }: { filters: RequestFilters; onChange: (f: RequestFilters) => void }) {
  const [lang] = useLang();
  const [providers] = useLoad<Provider[]>("/providers");
  const [systems] = useLoad<System[]>("/systems");
  const query = requestQuery(filters);
  const [list, reload] = useLoad<{ rows: UsageRequest[] }>(`/usage/requests?${query}`);
  // Pages after the first, fetched with `before`; dropped when the filters change.
  const [more, setMore] = useState<{ query: string; rows: UsageRequest[]; done: boolean }>({ query, rows: [], done: false });
  const [fetching, setFetching] = useState(false);
  const [moreError, setMoreError] = useState(false);
  useEffect(() => {
    setMore({ query, rows: [], done: false });
    setMoreError(false);
  }, [query]);

  const first = list.status === "ready" ? list.data.rows : [];
  const extra = more.query === query ? more.rows : [];
  const rows = [...first, ...extra];
  const done = (more.query === query && more.done) || (extra.length === 0 && first.length < PAGE);
  const set = (patch: Partial<RequestFilters>) => onChange({ ...filters, ...patch });
  const filtered = Object.values(filters).some((v) => v !== "");

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setFetching(true);
    setMoreError(false);
    try {
      const page = await api<{ rows: UsageRequest[] }>(`/usage/requests?${query}&before=${last.id}`);
      setMore((m) => ({ query, rows: [...(m.query === query ? m.rows : []), ...page.rows], done: page.rows.length < PAGE }));
    } catch {
      setMoreError(true);
    } finally {
      setFetching(false);
    }
  };

  const exportCsv = () =>
    downloadCsv("usage-requests.csv", [
      [t("usage.col.time"), t("usage.col.model"), t("usage.col.provider"), t("usage.col.system"), t("usage.col.status"), t("usage.input"), t("usage.output"), t("usage.cacheWrite"), t("usage.cacheRead"), t("usage.col.latency")],
      ...rows.map((r) => [
        new Date(r.at * 1000).toISOString(),
        r.model,
        r.provider,
        r.system_id,
        r.status,
        r.input_tokens,
        r.output_tokens,
        r.cache_creation_input_tokens,
        r.cache_read_input_tokens,
        r.latency_ms,
      ]),
    ]);

  return (
    <Stack gap={4}>
      <Card>
        <Stack gap={3}>
          <Grid minItemWidth="12rem" gap={3}>
            <label className="filter-field">
              <span>{t("usage.filter.provider")}</span>
              <Select
                value={filters.provider}
                onChange={(e) => set({ provider: e.target.value })}
                options={[{ value: "", label: t("usage.filter.all") }, ...(providers.status === "ready" ? providers.data.map((p) => ({ value: p.id, label: p.name })) : [])]}
              />
            </label>
            <Field label={t("usage.filter.model")} placeholder={t("usage.filter.modelHint")} value={filters.model} onChange={(e) => set({ model: e.target.value })} />
            <label className="filter-field">
              <span>{t("usage.filter.key")}</span>
              <Select
                value={filters.system}
                onChange={(e) => set({ system: e.target.value })}
                options={[{ value: "", label: t("usage.filter.allKeys") }, ...(systems.status === "ready" ? systems.data.map((s) => ({ value: s.id, label: s.name })) : [])]}
              />
            </label>
            <Field label={t("usage.filter.from")} type="datetime-local" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
            <Field label={t("usage.filter.to")} type="datetime-local" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
          </Grid>
          <Stack direction="row" gap={3} justify="between">
            <Segmented
              label={t("usage.filter.status")}
              value={filters.status}
              onChange={(v) => set({ status: v as StatusFilter })}
              options={[
                { value: "", label: t("usage.filter.statusAll") },
                { value: "ok", label: t("usage.filter.statusOk") },
                { value: "error", label: t("usage.filter.statusError") },
              ]}
            />
            {filtered && (
              <Button size="sm" variant="ghost" icon="close" onClick={() => onChange(NO_FILTERS)}>
                {t("usage.filter.clear")}
              </Button>
            )}
          </Stack>
        </Stack>
      </Card>
      {list.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      <Card
        flush
        title={t("usage.detailsCaption")}
        headingLevel={2}
        subtitle={list.status === "ready" ? t("usage.shown", { n: formatNumber(rows.length) }) : undefined}
        actions={
          <Button size="sm" icon="download" onClick={exportCsv} disabled={rows.length === 0}>
            {t("usage.export")}
          </Button>
        }
      >
        <RequestTable
          caption={t("usage.detailsCaption")}
          rows={rows}
          loading={list.status === "loading"}
          empty={<EmptyState size="inline" icon="activity" title={t("usage.detailsEmpty")} />}
        />
      </Card>
      {moreError && <Banner tone="danger" title={t("error.load")} action={<Button onClick={loadMore}>{t("common.retry")}</Button>} />}
      {list.status === "ready" && !done && (
        <Stack direction="row" justify="center">
          <Button onClick={loadMore} disabled={fetching}>
            {t("usage.loadMore")}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
