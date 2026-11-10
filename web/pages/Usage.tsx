import { useState } from "react";
import { Banner, Button, Card, DataTable, EmptyState, Grid, PageHeader, Select, Stack, StatTile, type DataTableColumn } from "@xdev-asia/ui";
import { useLoad, type UsageReport, type UsageRow } from "../api";
import { formatNumber, t, useLang } from "../i18n";
import { ui } from "../ui-labels";

/** The last 12 UTC months, newest first, as `YYYY-MM`. */
export function lastMonths(now = new Date(), count = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const sum = (rows: UsageRow[], f: keyof Omit<UsageRow, "system_id" | "provider" | "model">) => rows.reduce((n, r) => n + r[f], 0);

export function Usage() {
  const [lang] = useLang();
  const labels = ui(lang);
  const months = lastMonths();
  const [month, setMonth] = useState(months[0]!);
  const [report, reload] = useLoad<UsageReport>(`/usage?month=${month}`);
  const rows = report.status === "ready" ? report.data.rows : [];
  const loading = report.status === "loading";

  const columns: DataTableColumn<UsageRow>[] = [
    { key: "system", header: t("usage.col.system"), cell: (r) => r.system_id, mono: true },
    { key: "model", header: t("usage.col.model"), cell: (r) => r.model ?? "—", mono: true },
    { key: "requests", header: t("usage.requests"), align: "end", cell: (r) => formatNumber(r.requests) },
    { key: "input", header: t("usage.input"), align: "end", cell: (r) => formatNumber(r.input_tokens) },
    { key: "output", header: t("usage.output"), align: "end", cell: (r) => formatNumber(r.output_tokens) },
    { key: "cacheWrite", header: t("usage.cacheWrite"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_creation_input_tokens) },
    { key: "cacheRead", header: t("usage.cacheRead"), align: "end", hideNarrow: true, cell: (r) => formatNumber(r.cache_read_input_tokens) },
  ];

  return (
    <Stack gap={4}>
      <PageHeader
        title={t("usage.title")}
        description={t("usage.description")}
        actions={<Select aria-label={t("usage.month")} icon="calendar" value={month} options={months.map((m) => ({ value: m, label: m }))} onChange={(e) => setMonth(e.target.value)} />}
      />
      {report.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      <Grid minItemWidth="14rem" gap={3}>
        <StatTile label={t("usage.requests")} value={formatNumber(sum(rows, "requests"))} loading={loading} labels={labels.statTile} />
        <StatTile label={t("usage.input")} value={formatNumber(sum(rows, "input_tokens"))} loading={loading} labels={labels.statTile} />
        <StatTile label={t("usage.output")} value={formatNumber(sum(rows, "output_tokens"))} loading={loading} labels={labels.statTile} />
        <StatTile label={t("usage.cacheRead")} value={formatNumber(sum(rows, "cache_read_input_tokens"))} loading={loading} labels={labels.statTile} />
      </Grid>
      <Card flush>
        <DataTable
          caption={t("usage.caption")}
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.system_id}/${r.provider}/${r.model ?? ""}`}
          loading={loading}
          labels={labels.dataTable}
          empty={<EmptyState icon="activity" title={t("usage.empty")} />}
        />
      </Card>
    </Stack>
  );
}
