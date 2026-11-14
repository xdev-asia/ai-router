import { useState, type ReactNode } from "react";
import {
  Banner,
  BarChart,
  BrandMark,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  FlowMap,
  Grid,
  Segmented,
  Select,
  Skeleton,
  Stack,
  StatTile,
  StatusDot,
  Tabs,
  TimeSeriesChart,
  type BarDatum,
  type DataTableColumn,
  type FlowMapNode,
  type TimeSeriesTick,
} from "@xdev-asia/ui";
import { useLoad, type Connection, type Provider, type UsageBucket, type UsageChart, type UsagePeriod, type UsageRequest, type UsageSummary, type UsageTokens } from "../api";
import { providerLogo } from "../provider-logos";
import { formatNumber, t, useLang, type Lang, type StringKey } from "../i18n";
import { ui } from "../ui-labels";

const PERIODS: UsagePeriod[] = ["today", "24h", "7d", "30d", "60d", "all"];
/** Rows in the side list next to the map; the Details tab has the rest. */
const SIDE_ROWS = 8;
/** Bars in the top models chart; the breakdown table has every model. */
const TOP_MODELS = 5;

export type Metric = "tokens" | "requests" | "cost";
type Breakdown = "model" | "account" | "key";

/**
 * The map's nodes: every provider with an account, plus any that served the period (an account deleted since),
 * by name so a node keeps its place. A node that served requests is active and says how many.
 */
export function flowNodes(connections: Connection[], providers: Provider[], byProvider: UsageSummary["by_provider"]): FlowMapNode[] {
  const served = new Map(byProvider.map((r) => [r.provider, r.requests]));
  const ids = new Set([...connections.map((c) => c.provider), ...served.keys()]);
  const info = new Map(providers.map((p) => [p.id, p]));
  return [...ids]
    .map((id) => {
      const p = info.get(id);
      const n = served.get(id) ?? 0;
      return {
        id,
        name: p?.name ?? id,
        src: providerLogo(id),
        color: p?.color,
        text: p?.mark,
        active: n > 0,
        detail: n > 0 ? t("usage.flow.requests", { n: formatNumber(n) }) : undefined,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "~$3.60": a dollar estimate, never an exact bill. A dash when nothing in the group has a price. */
export const formatCost = (cost: number | null): string => (cost === null ? "—" : `~$${cost.toFixed(2)}`);

const locale = (lang: Lang) => (lang === "vi" ? "vi-VN" : "en-US");

const formatTime = (at: number, lang: Lang) =>
  new Date(at * 1000).toLocaleString(locale(lang), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The caller's offset in minutes east of UTC, so "today" and the chart's days follow the owner's calendar. */
const tzMinutes = () => -new Date().getTimezoneOffset();

/** Every token a group counted: input, output and both cache kinds. */
export const allTokens = (r: UsageTokens): number => r.input_tokens + r.output_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens;

/** A bucket's value under a measure; null (a gap, not zero) when it has requests but no price. */
export function bucketValue(b: UsageBucket, metric: Metric): number | null {
  return metric === "tokens" ? b.tokens : metric === "requests" ? b.requests : b.cost;
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

function Status({ code }: { code: number }) {
  return <StatusDot tone={code < 400 ? "ok" : code === 429 || code >= 500 ? "warn" : "danger"} label={String(code)} />;
}

/** Usage: an Overview of a period and a Details list of single requests. */
export function Usage() {
  useLang();
  const [tab, setTab] = useState("overview");
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
      {tab === "details" ? <Details /> : <Overview onViewAll={() => setTab("details")} />}
    </Stack>
  );
}

function MetricPicker({ value, onChange, withCost }: { value: Metric; onChange: (m: Metric) => void; withCost?: boolean }) {
  const metrics: Metric[] = withCost ? ["tokens", "requests", "cost"] : ["tokens", "requests"];
  return (
    <Segmented
      label={t("usage.metric")}
      value={value}
      onChange={(v) => onChange(v as Metric)}
      options={metrics.map((m) => ({ value: m, label: t(`usage.metric.${m}` as StringKey) }))}
    />
  );
}

function Overview({ onViewAll }: { onViewAll: () => void }) {
  const [lang] = useLang();
  const [connections] = useLoad<Connection[]>("/connections");
  const [providers] = useLoad<Provider[]>("/providers");
  const labels = ui(lang);
  const [period, setPeriod] = useState<UsagePeriod>("24h");
  // "today" starts at the owner's midnight; the rolling periods need no offset.
  const [report, reload] = useLoad<UsageSummary>(`/usage/summary?period=${period}${period === "today" ? `&tz=${tzMinutes()}` : ""}`);
  const loading = report.status === "loading";
  const data = report.status === "ready" ? report.data : null;
  const totals = data?.totals;
  const number = (n: number | undefined) => formatNumber(n ?? 0);
  const providerName = new Map((providers.status === "ready" ? providers.data : []).map((p) => [p.id, p.name]));
  const empty = <EmptyState icon="activity" title={t("usage.noRequests")} />;

  return (
    <Stack gap={4}>
      <Segmented label={t("usage.period")} value={period} onChange={(v) => setPeriod(v as UsagePeriod)} options={PERIODS.map((p) => ({ value: p, label: t(`usage.period.${p}` as StringKey) }))} />
      {report.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      <Grid minItemWidth="11rem" gap={3}>
        <StatTile label={t("usage.requests")} value={number(totals?.requests)} loading={loading} labels={labels.statTile} />
        <StatTile label={t("usage.input")} value={number(totals?.input_tokens)} loading={loading} labels={labels.statTile} />
        <StatTile label={t("usage.cacheRead")} value={number(totals?.cache_read_input_tokens)} loading={loading} labels={labels.statTile} />
        <StatTile label={t("usage.output")} value={number(totals?.output_tokens)} loading={loading} labels={labels.statTile} />
        <StatTile label={t("usage.cost")} value={formatCost(totals?.cost ?? null)} hint={t("usage.costHint")} loading={loading} labels={labels.statTile} />
      </Grid>
      {totals && totals.unpriced_requests > 0 && <Banner tone="info" title={t("usage.unpriced", { n: formatNumber(totals.unpriced_requests) })} />}
      {/* The topology on two thirds, the latest requests beside it. */}
      <div className="usage-flow">
        <FlowMap
          label={t("usage.flow.label")}
          labels={{ zoomIn: t("usage.flow.zoomIn"), zoomOut: t("usage.flow.zoomOut"), fit: t("usage.flow.fit"), controls: t("usage.flow.controls") }}
          hub={{ name: t("app.name"), mark: <BrandMark variant="tile" size={28} /> }}
          nodes={flowNodes(
            connections.status === "ready" ? connections.data : [],
            providers.status === "ready" ? providers.data : [],
            data?.by_provider ?? [],
          )}
        />
        <Card
          title={t("usage.recent")}
          headingLevel={2}
          flush
          actions={<Button size="sm" onClick={onViewAll}>{t("usage.viewAll")}</Button>}
        >
          <RequestTable compact caption={t("usage.recent")} rows={(data?.recent ?? []).slice(0, SIDE_ROWS)} loading={loading} empty={empty} />
        </Card>
      </div>
      <OverTime period={period} />
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
      <BreakdownCard data={data} loading={loading} providerName={providerName} empty={empty} />
    </Stack>
  );
}

/** The usage chart: one series over the period, as tokens, requests or cost. */
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
    <Card title={t("usage.chart.title")} headingLevel={2} actions={<MetricPicker value={metric} onChange={setMetric} withCost />}>
      {chart.status === "loading" && <Skeleton lines={4} announce labels={{ loading: t("loading") }} />}
      {chart.status === "error" && <Banner tone="danger" title={t("usage.chart.error")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {data && quiet && <EmptyState icon="activity" title={t("usage.noRequests")} />}
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
    <Card title={title} headingLevel={2} actions={<MetricPicker value={metric} onChange={setMetric} />}>
      {loading ? <Skeleton lines={3} announce labels={{ loading: t("loading") }} /> : bars.length === 0 ? empty : <BarChart label={chartLabel(metric)} bars={bars} />}
    </Card>
  );
}

/** The "Usage by Model / Account / API Key" table: one row per group with its last use. */
function BreakdownCard({
  data,
  loading,
  providerName,
  empty,
}: {
  data: UsageSummary | null;
  loading: boolean;
  providerName: ReadonlyMap<string, string>;
  empty: ReactNode;
}) {
  const [lang] = useLang();
  const labels = ui(lang);
  const [group, setGroup] = useState<Breakdown>("model");
  const groupName = t(`usage.breakdown.${group}` as StringKey);
  const caption = t("usage.breakdown.caption", { group: groupName });
  const lastUsed = (at: number | null | undefined) => (at ? formatTime(at, lang) : "—");
  const provider = <T extends { provider: string }>(): DataTableColumn<T> => ({
    key: "provider",
    header: t("usage.col.provider"),
    hideNarrow: true,
    cell: (r) => providerName.get(r.provider) ?? r.provider,
  });
  const numbers = <T extends UsageTokens & { last_at?: number | null }>(): DataTableColumn<T>[] => [
    { key: "requests", header: t("usage.requests"), align: "end", cell: (r) => formatNumber(r.requests) },
    { key: "input", header: t("usage.input"), align: "end", cell: (r) => formatNumber(r.input_tokens) },
    { key: "output", header: t("usage.output"), align: "end", cell: (r) => formatNumber(r.output_tokens) },
    { key: "cacheRead", header: t("usage.cacheRead"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_read_input_tokens) },
    { key: "cost", header: t("usage.col.cost"), align: "end", cell: (r) => formatCost(r.cost) },
    { key: "lastUsed", header: t("usage.col.lastUsed"), hideNarrow: true, cell: (r) => lastUsed(r.last_at) },
  ];
  const common = { caption, loading, labels: labels.dataTable, empty };

  type ModelRow = UsageSummary["by_model"][number];
  type AccountRow = NonNullable<UsageSummary["by_connection"]>[number];
  type KeyRow = UsageSummary["by_system"][number];
  const table =
    group === "model" ? (
      <DataTable<ModelRow>
        {...common}
        columns={[{ key: "model", header: t("usage.col.model"), mono: true, cell: (r) => r.model ?? "—" }, provider<ModelRow>(), ...numbers<ModelRow>()]}
        rows={data?.by_model ?? []}
        rowKey={(r) => `${r.provider}/${r.model ?? ""}`}
      />
    ) : group === "account" ? (
      <DataTable<AccountRow>
        {...common}
        columns={[
          {
            key: "account",
            header: t("usage.col.account"),
            // The account's name and the key's last characters only; the key itself never reaches the console.
            cell: (r) => (r.connection_id === null ? t("usage.noAccount") : [r.name, r.hint].filter(Boolean).join(" · ") || r.connection_id),
          },
          provider<AccountRow>(),
          ...numbers<AccountRow>(),
        ]}
        rows={data?.by_connection ?? []}
        rowKey={(r) => `${r.provider}/${r.connection_id ?? ""}`}
      />
    ) : (
      <DataTable<KeyRow>
        {...common}
        columns={[{ key: "key", header: t("usage.col.key"), cell: (r) => r.name ?? r.system_id }, ...numbers<KeyRow>()]}
        rows={data?.by_system ?? []}
        rowKey={(r) => r.system_id}
      />
    );

  return (
    <Card
      title={t("usage.breakdown")}
      headingLevel={2}
      flush
      actions={
        <Segmented
          label={t("usage.breakdown.by")}
          value={group}
          onChange={(v) => setGroup(v as Breakdown)}
          options={(["model", "account", "key"] as const).map((g) => ({ value: g, label: t(`usage.breakdown.${g}` as StringKey) }))}
        />
      }
    >
      {table}
    </Card>
  );
}

/** `compact`: the side list beside the map, time, model and status only. */
function RequestTable({ caption, rows, loading, empty, compact }: { caption: string; rows: UsageRequest[]; loading: boolean; empty: ReactNode; compact?: boolean }) {
  const [lang] = useLang();
  const all: DataTableColumn<UsageRequest>[] = [
    { key: "time", header: t("usage.col.time"), cell: (r) => formatTime(r.at, lang) },
    { key: "model", header: t("usage.col.model"), mono: true, cell: (r) => r.model ?? "—" },
    { key: "provider", header: t("usage.col.provider"), mono: true, hideNarrow: true, cell: (r) => r.provider },
    { key: "system", header: t("usage.col.system"), mono: true, hideNarrow: true, cell: (r) => r.system_id },
    { key: "status", header: t("usage.col.status"), cell: (r) => <Status code={r.status} /> },
    { key: "input", header: t("usage.input"), align: "end", cell: (r) => formatNumber(r.input_tokens) },
    { key: "cacheRead", header: t("usage.cacheRead"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_read_input_tokens) },
    { key: "cacheWrite", header: t("usage.cacheWrite"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_creation_input_tokens) },
    { key: "output", header: t("usage.output"), align: "end", cell: (r) => formatNumber(r.output_tokens) },
    { key: "latency", header: t("usage.col.latency"), align: "end", cell: (r) => (r.latency_ms === null ? "—" : `${formatNumber(r.latency_ms)} ms`) },
  ];
  const columns = compact ? all.filter((c) => ["time", "model", "status"].includes(c.key)) : all;
  return <DataTable caption={caption} columns={columns} rows={rows} rowKey={(r) => String(r.id)} loading={loading} labels={ui(lang).dataTable} empty={empty} />;
}

/** datetime-local value ("2026-11-12T08:30") to unix seconds; null when empty or unreadable. */
function toUnix(local: string): number | null {
  const ms = local ? Date.parse(local) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** One row per request, newest first, narrowed by provider and time. */
function Details() {
  useLang();
  const [provider, setProvider] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [providers] = useLoad<Provider[]>("/providers");

  const query = ["limit=100"];
  if (provider) query.push(`provider=${encodeURIComponent(provider)}`);
  const fromUnix = toUnix(from);
  const toUnixValue = toUnix(to);
  if (fromUnix !== null) query.push(`from=${fromUnix}`);
  if (toUnixValue !== null) query.push(`to=${toUnixValue}`);
  const [list, reload] = useLoad<{ rows: UsageRequest[] }>(`/usage/requests?${query.join("&")}`);

  return (
    <Stack gap={4}>
      <Card>
        <Grid minItemWidth="14rem" gap={3}>
          <label className="filter-field">
            <span>{t("usage.filter.provider")}</span>
            <Select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              options={[{ value: "", label: t("usage.filter.all") }, ...(providers.status === "ready" ? providers.data.map((p) => ({ value: p.id, label: p.name })) : [])]}
            />
          </label>
          <Field label={t("usage.filter.from")} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Field label={t("usage.filter.to")} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </Grid>
      </Card>
      {list.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      <Card flush>
        <RequestTable
          caption={t("usage.detailsCaption")}
          rows={list.status === "ready" ? list.data.rows : []}
          loading={list.status === "loading"}
          empty={<EmptyState icon="activity" title={t("usage.detailsEmpty")} />}
        />
      </Card>
    </Stack>
  );
}
