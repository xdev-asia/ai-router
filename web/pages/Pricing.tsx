import { useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FormDialog,
  IconButton,
  SearchInput,
  Select,
  Skeleton,
  Stack,
  type DataTableColumn,
} from "@xdev-asia/ui";
import { ApiError, api, useLoad, type PriceRates, type PriceRow, type Provider } from "../api";
import { t, useLang } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";

/** The gateway's rule for a price's model (worker/report.ts): `provider/model`, or a prefix of one. */
export const PRICE_TARGET = /^[a-z][a-z0-9-]*\/[A-Za-z0-9._:/@+-]{1,200}$/;

type Pending = { kind: "edit"; row: PriceRow | null } | { kind: "reset"; row: PriceRow } | null;

const providerOf = (target: string) => target.slice(0, target.indexOf("/"));
const modelOf = (target: string) => target.slice(target.indexOf("/") + 1);

/** "$1.25" per 1M tokens; four decimals at most, no trailing zeros. */
export const formatPrice = (n: number): string => `$${Number(n.toFixed(4))}`;

/** Prices whose model contains the query (ignoring case), from one provider when one is picked. */
export function filterPrices(rows: readonly PriceRow[], query: string, provider: string): PriceRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (!provider || providerOf(r.target) === provider) && (!q || r.target.toLowerCase().includes(q)));
}

/** A typed dollar amount; empty is `blank` (0 for the cache prices, an error for input and output). */
function parsePrice(v: string, blank: number | null): number | null {
  const s = v.trim();
  if (!s) return blank;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Pricing: the per-1M-token prices the Usage page estimates cost with. */
export function Pricing() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [prices, reload] = useLoad<PriceRow[]>("/pricing");
  const [providers] = useLoad<Provider[]>("/providers");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = prices.status === "ready" ? prices.data : [];
  const shown = useMemo(() => filterPrices(all, query, provider), [all, query, provider]);
  const names = new Map((providers.status === "ready" ? providers.data : []).map((p) => [p.id, p.name]));
  const providerIds = [...new Set(all.map((r) => providerOf(r.target)))].sort();
  const filtering = query.trim() !== "" || provider !== "";

  /** Drops the owner's price: a built-in price applies again, or the model has none. */
  async function reset(row: PriceRow) {
    setBusy(true);
    setError(null);
    try {
      await api(`/pricing?target=${encodeURIComponent(row.target)}`, { method: "DELETE" });
      notify(row.default ? t("pricing.resetDone", { target: row.target }) : t("pricing.removed", { target: row.target }));
      setPending(null);
      reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
      setPending(null);
      reload();
    } finally {
      setBusy(false);
    }
  }

  const columns: DataTableColumn<PriceRow>[] = [
    { key: "model", header: t("pricing.col.model"), mono: true, cell: (r) => modelOf(r.target) },
    { key: "provider", header: t("pricing.col.provider"), hideNarrow: true, cell: (r) => names.get(providerOf(r.target)) ?? providerOf(r.target) },
    { key: "input", header: t("pricing.col.input"), align: "end", cell: (r) => formatPrice(r.input) },
    { key: "output", header: t("pricing.col.output"), align: "end", cell: (r) => formatPrice(r.output) },
    { key: "cacheRead", header: t("pricing.col.cacheRead"), align: "end", hideNarrow: true, cell: (r) => formatPrice(r.cache_read) },
    { key: "cacheWrite", header: t("pricing.col.cacheWrite"), align: "end", hideNarrow: true, cell: (r) => formatPrice(r.cache_write) },
    {
      key: "source",
      header: t("pricing.col.source"),
      cell: (r) => (r.custom ? <Badge status="changed">{t("pricing.custom")}</Badge> : <Badge status="neutral">{t("pricing.builtIn")}</Badge>),
    },
    {
      key: "actions",
      header: <span className="x-sr-only">{t("pricing.col.actions")}</span>,
      width: "min",
      cell: (r) => (
        <span className="pricing-actions">
          <IconButton icon="edit" label={t("pricing.editOne", { target: r.target })} disabled={busy} onClick={() => setPending({ kind: "edit", row: r })} />
          {r.custom && (
            <IconButton
              icon={r.default ? "undo" : "trash"}
              label={r.default ? t("pricing.resetOne", { target: r.target }) : t("pricing.removeOne", { target: r.target })}
              disabled={busy}
              onClick={() => setPending({ kind: "reset", row: r })}
            />
          )}
        </span>
      ),
    },
  ];

  return (
    <Stack gap={4}>
      <div className="page-actions">
        <p className="page-intro">{t("pricing.intro")}</p>
        <div className="pricing-tools">
          <SearchInput
            size="md"
            aria-label={t("pricing.searchLabel")}
            placeholder={t("pricing.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            labels={labels.searchInput}
          />
          <Select
            aria-label={t("pricing.provider")}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            options={[{ value: "", label: t("pricing.allProviders") }, ...providerIds.map((id) => ({ value: id, label: names.get(id) ?? id }))]}
          />
          <Button variant="primary" icon="plus" onClick={() => setPending({ kind: "edit", row: null })}>
            {t("pricing.add")}
          </Button>
        </div>
      </div>
      {error && <Banner tone="danger" title={error} />}
      {filtering && all.length > 0 && (
        <p className="pricing-count" role="status">
          {t("pricing.shown", { n: String(shown.length), total: String(all.length) })}
        </p>
      )}
      <Card flush>
        {prices.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
        {prices.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
        {prices.status === "ready" && (
          <DataTable
            caption={t("pricing.caption")}
            columns={columns}
            rows={shown}
            rowKey={(r) => r.target}
            labels={labels.dataTable}
            empty={
              <EmptyState
                icon="search"
                title={t("pricing.noMatch")}
                actions={
                  filtering ? (
                    <Button
                      onClick={() => {
                        setQuery("");
                        setProvider("");
                      }}
                    >
                      {t("pricing.clearSearch")}
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </Card>
      {pending?.kind === "edit" && (
        <PriceDialog
          row={pending.row}
          onCancel={() => setPending(null)}
          onSaved={(target) => {
            notify(t("pricing.saved", { target }));
            setPending(null);
            reload();
          }}
        />
      )}
      {pending?.kind === "reset" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={pending.row.default ? t("pricing.resetTitle", { target: pending.row.target }) : t("pricing.removeTitle", { target: pending.row.target })}
          labels={labels.dialog}
          confirmLabel={pending.row.default ? t("pricing.reset") : t("pricing.remove")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void reset(pending.row)}
        >
          {pending.row.default ? t("pricing.resetBody") : t("pricing.removeBody")}
        </Dialog>
      )}
    </Stack>
  );
}

function PriceDialog({ row, onCancel, onSaved }: { row: PriceRow | null; onCancel: () => void; onSaved: (target: string) => void }) {
  const [lang] = useLang();
  const labels = ui(lang);
  const text = (n: number | undefined) => (n === undefined ? "" : String(n));
  const [target, setTarget] = useState(row?.target ?? "");
  const [input, setInput] = useState(text(row?.input));
  const [output, setOutput] = useState(text(row?.output));
  const [cacheRead, setCacheRead] = useState(text(row?.cache_read));
  const [cacheWrite, setCacheWrite] = useState(text(row?.cache_write));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = target.trim();
  const targetError = PRICE_TARGET.test(trimmed) ? null : t("pricing.invalidTarget");
  const rates = { input: parsePrice(input, null), output: parsePrice(output, null), cache_read: parsePrice(cacheRead, 0), cache_write: parsePrice(cacheWrite, 0) };
  const bad = (v: number | null) => (tried && v === null ? t("pricing.invalidPrice") : undefined);
  const builtIn: PriceRates | null = row?.default ?? null;

  async function submit() {
    setTried(true);
    if (targetError || Object.values(rates).some((v) => v === null)) return;
    setBusy(true);
    setError(null);
    try {
      await api("/pricing", { method: "PUT", body: { target: trimmed, ...rates } });
      onSaved(trimmed);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setError(t("pricing.invalid"));
      else if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={row ? t("pricing.editTitle", { target: row.target }) : t("pricing.addTitle")}
      submitLabel={t("common.save")}
      labels={labels.formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field
        label={t("pricing.target")}
        hint={t("pricing.targetHint")}
        value={target}
        disabled={row !== null}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setTarget(e.target.value)}
        error={tried && targetError ? targetError : undefined}
      />
      <p className="pricing-hint">
        {builtIn
          ? t("pricing.builtInIs", {
              input: formatPrice(builtIn.input),
              output: formatPrice(builtIn.output),
              cacheRead: formatPrice(builtIn.cache_read),
              cacheWrite: formatPrice(builtIn.cache_write),
            })
          : t("pricing.ratesHint")}
      </p>
      <div className="pricing-rates">
        <Field label={t("pricing.col.input")} inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} error={bad(rates.input)} />
        <Field label={t("pricing.col.output")} inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} error={bad(rates.output)} />
        <Field label={t("pricing.col.cacheRead")} inputMode="decimal" value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} error={bad(rates.cache_read)} />
        <Field label={t("pricing.col.cacheWrite")} inputMode="decimal" value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} error={bad(rates.cache_write)} />
      </div>
    </FormDialog>
  );
}
