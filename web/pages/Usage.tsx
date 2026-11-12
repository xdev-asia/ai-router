import { useState, type ReactNode } from "react";
import { Banner, Button, Card, DataTable, EmptyState, Field, Grid, PageHeader, Segmented, Select, Stack, StatTile, StatusDot, Tabs, type DataTableColumn } from "@xdev-asia/ui";
import { useLoad, type Provider, type UsagePeriod, type UsageRequest, type UsageSummary, type UsageTokens } from "../api";
import { formatNumber, t, useLang, type Lang, type StringKey } from "../i18n";
import { ui } from "../ui-labels";

const PERIODS: UsagePeriod[] = ["today", "24h", "7d", "30d", "60d", "all"];

/** "~$3.60": a dollar estimate, never an exact bill. A dash when nothing in the group has a price. */
export const formatCost = (cost: number | null): string => (cost === null ? "—" : `~$${cost.toFixed(2)}`);

const formatTime = (at: number, lang: Lang) =>
  new Date(at * 1000).toLocaleString(lang === "vi" ? "vi-VN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** datetime-local value ("2026-11-12T08:30") to unix seconds; null when empty or unreadable. */
function toUnix(local: string): number | null {
  const ms = local ? Date.parse(local) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function Status({ code }: { code: number }) {
  return <StatusDot tone={code < 400 ? "ok" : code === 429 || code >= 500 ? "warn" : "danger"} label={String(code)} />;
}

/** Usage, laid out as 9router's page: an Overview of a period and a Details list of single requests. */
export function Usage() {
  useLang();
  const [tab, setTab] = useState("overview");
  return (
    <Stack gap={4}>
      <PageHeader title={t("usage.title")} description={t("usage.description")} />
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
      {tab === "details" ? <Details /> : <Overview />}
    </Stack>
  );
}

function Overview() {
  const [lang] = useLang();
  const labels = ui(lang);
  const [period, setPeriod] = useState<UsagePeriod>("24h");
  const [report, reload] = useLoad<UsageSummary>(`/usage/summary?period=${period}`);
  const loading = report.status === "loading";
  const data = report.status === "ready" ? report.data : null;
  const totals = data?.totals;
  const number = (n: number | undefined) => formatNumber(n ?? 0);

  const tokenColumns = <T extends UsageTokens>(first: DataTableColumn<T>[]): DataTableColumn<T>[] => [
    ...first,
    { key: "requests", header: t("usage.requests"), align: "end", cell: (r) => formatNumber(r.requests) },
    { key: "input", header: t("usage.input"), align: "end", cell: (r) => formatNumber(r.input_tokens) },
    { key: "output", header: t("usage.output"), align: "end", cell: (r) => formatNumber(r.output_tokens) },
    { key: "cacheRead", header: t("usage.cacheRead"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_read_input_tokens) },
    { key: "cost", header: t("usage.col.cost"), align: "end", cell: (r) => formatCost(r.cost) },
  ];
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
      <Grid columns={{ base: 1, lg: 2 }} gap={3}>
        <Card title={t("usage.byProvider")} headingLevel={2} flush>
          <DataTable
            caption={t("usage.byProvider")}
            columns={tokenColumns<UsageSummary["by_provider"][number]>([{ key: "provider", header: t("usage.col.provider"), mono: true, cell: (r) => r.provider }])}
            rows={data?.by_provider ?? []}
            rowKey={(r) => r.provider}
            loading={loading}
            labels={labels.dataTable}
            empty={empty}
          />
        </Card>
        <Card title={t("usage.bySystem")} headingLevel={2} flush>
          <DataTable
            caption={t("usage.bySystem")}
            columns={tokenColumns<UsageSummary["by_system"][number]>([{ key: "system", header: t("usage.col.system"), mono: true, cell: (r) => r.system_id }])}
            rows={data?.by_system ?? []}
            rowKey={(r) => r.system_id}
            loading={loading}
            labels={labels.dataTable}
            empty={empty}
          />
        </Card>
      </Grid>
      <Card title={t("usage.topModels")} headingLevel={2} flush>
        <DataTable
          caption={t("usage.topModels")}
          columns={tokenColumns<UsageSummary["by_model"][number]>([
            { key: "model", header: t("usage.col.model"), mono: true, cell: (r) => r.model ?? "—" },
            { key: "provider", header: t("usage.col.provider"), mono: true, hideNarrow: true, cell: (r) => r.provider },
          ])}
          rows={data?.by_model ?? []}
          rowKey={(r) => `${r.provider}/${r.model ?? ""}`}
          loading={loading}
          labels={labels.dataTable}
          empty={empty}
        />
      </Card>
      <Card title={t("usage.recent")} headingLevel={2} flush>
        <RequestTable caption={t("usage.recent")} rows={data?.recent ?? []} loading={loading} empty={empty} />
      </Card>
    </Stack>
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
    { key: "input", header: t("usage.input"), align: "end", cell: (r) => formatNumber(r.input_tokens) },
    { key: "cacheRead", header: t("usage.cacheRead"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_read_input_tokens) },
    { key: "cacheWrite", header: t("usage.cacheWrite"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_creation_input_tokens) },
    { key: "output", header: t("usage.output"), align: "end", cell: (r) => formatNumber(r.output_tokens) },
    { key: "latency", header: t("usage.col.latency"), align: "end", cell: (r) => (r.latency_ms === null ? "—" : `${formatNumber(r.latency_ms)} ms`) },
  ];
  return <DataTable caption={caption} columns={columns} rows={rows} rowKey={(r) => String(r.id)} loading={loading} labels={ui(lang).dataTable} empty={empty} />;
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
