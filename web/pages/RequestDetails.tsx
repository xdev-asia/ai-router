import { useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  IconButton,
  SearchInput,
  Skeleton,
  Stack,
  StatusDot,
  Switch,
  type DataTableColumn,
} from "@xdev-asia/ui";
import { ApiError, api } from "../api";
import { t, useLang } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";

/** One row of GET /admin/request-details (worker/request-details.ts). Bodies are cut to 5 KB and keys are masked. */
export interface RequestDetail {
  id: number;
  /** Milliseconds since the epoch. */
  at: number;
  system_id: string | null;
  model: string | null;
  path: string;
  status: number;
  took_ms: number;
  ttft_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  request: string | null;
  response: string | null;
  thinking: string | null;
}

/** The list path, filtered by model on the worker. */
export function detailsPath(model: string): string {
  const m = model.trim();
  return m ? `/request-details?${new URLSearchParams({ model: m })}` : "/request-details";
}

/** The request as indented JSON when it is whole; a cut body stays as it came. */
function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/**
 * Request details (Observability): while recording is on, each call to the gateway keeps what the client
 * sent and the reply it got, with the time to the first streamed chunk and the tokens. Off by default.
 */
export function RequestDetails() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [rows, setRows] = useState<RequestDetail[] | null>(null);
  const [kept, setKept] = useState(200);
  const [query, setQuery] = useState("");
  const [model, setModel] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<RequestDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    api<{ enabled: boolean }>("/observability")
      .then((r) => setEnabled(r.enabled))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setModel(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const gen = ++generation.current;
    setRows(null);
    setLoadFailed(false);
    api<{ details: RequestDetail[]; kept: number }>(detailsPath(model))
      .then((r) => {
        if (gen !== generation.current) return;
        setRows(r.details);
        setKept(r.kept);
      })
      .catch(() => gen === generation.current && setLoadFailed(true));
  }, [model, attempt]);

  const failed = (e: unknown) => setError(e instanceof ApiError ? `${t("error.generic")} (${e.status})` : t("error.generic"));

  async function toggle(on: boolean) {
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ enabled: boolean }>("/observability", { method: "PUT", body: { enabled: on } });
      setEnabled(r.enabled);
      notify(t(r.enabled ? "details.turnedOn" : "details.turnedOff"));
    } catch (e) {
      failed(e);
    } finally {
      setSaving(false);
    }
  }

  async function show(row: RequestDetail) {
    setOpen(row);
    try {
      setOpen(await api<RequestDetail>(`/request-details/${row.id}`));
    } catch {
      // The row from the list already holds every field.
    }
  }

  async function clearAll() {
    setBusy(true);
    setError(null);
    try {
      await api("/request-details", { method: "DELETE" });
      setRows([]);
      setConfirming(false);
      notify(t("details.cleared"));
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  }

  const time = (at: number) =>
    new Date(at).toLocaleString(lang === "vi" ? "vi-VN" : "en-GB", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  const columns: DataTableColumn<RequestDetail>[] = [
    { key: "time", header: t("details.col.time"), mono: true, width: "min", cell: (d) => time(d.at) },
    { key: "model", header: t("details.col.model"), mono: true, cell: (d) => d.model ?? "—" },
    { key: "system", header: t("details.col.system"), mono: true, hideNarrow: true, cell: (d) => d.system_id ?? "—" },
    {
      key: "status",
      header: t("details.col.status"),
      width: "min",
      cell: (d) => <StatusDot tone={d.status < 400 ? "ok" : "danger"} label={String(d.status)} />,
    },
    { key: "tokens", header: t("details.col.tokens"), mono: true, align: "end", width: "min", cell: (d) => `${d.input_tokens} / ${d.output_tokens}` },
    { key: "ttft", header: t("details.col.ttft"), mono: true, align: "end", width: "min", hideNarrow: true, cell: (d) => (d.ttft_ms === null ? "—" : `${d.ttft_ms} ms`) },
    { key: "took", header: t("details.col.took"), mono: true, align: "end", width: "min", hideNarrow: true, cell: (d) => `${d.took_ms} ms` },
    {
      key: "open",
      header: "",
      label: t("details.col.open"),
      width: "min",
      sticky: "end",
      cell: (d) => <IconButton icon="eye" size="sm" label={t("details.open", { model: d.model ?? d.path })} onClick={() => void show(d)} />,
    },
  ];

  return (
    <Stack gap={4}>
      <Card title={t("details.title")} subtitle={t("details.hint", { n: String(kept) })} headingLevel={2}>
        {enabled === null ? (
          <Skeleton lines={1} announce labels={{ loading: t("loading") }} />
        ) : (
          <Stack gap={2}>
            <Switch label={t("details.record")} checked={enabled} disabled={saving} onChange={(e) => void toggle(e.target.checked)} />
            {!enabled && <p className="muted">{t("details.off")}</p>}
          </Stack>
        )}
      </Card>
      {error && <Banner tone="danger" title={error} />}
      <Stack direction="row" justify="between" gap={3} wrap>
        <SearchInput
          size="sm"
          placeholder={t("details.filter")}
          aria-label={t("details.filter")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          labels={labels.searchInput}
        />
        <Button size="sm" variant="ghost" icon="trash" disabled={!rows || rows.length === 0} onClick={() => setConfirming(true)}>
          {t("details.clear")}
        </Button>
      </Stack>
      <Card flush>
        {loadFailed ? (
          <Banner tone="danger" title={t("error.load")} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t("common.retry")}</Button>} />
        ) : (
          <DataTable
            caption={t("details.caption")}
            columns={columns}
            rows={rows ?? []}
            rowKey={(d) => String(d.id)}
            loading={rows === null}
            labels={labels.dataTable}
            empty={
              model ? (
                <EmptyState icon="search" title={t("details.noMatch")} actions={<Button onClick={() => setQuery("")}>{t("logs.clearFilters")}</Button>} />
              ) : (
                <EmptyState icon="activity" title={t("details.empty")} hint={enabled ? t("details.emptyHint") : undefined} />
              )
            }
          />
        )}
      </Card>
      {open && (
        <Drawer
          size="wide"
          title={open.model ?? open.path}
          description={`${open.path} · ${open.status} · ${time(open.at)}`}
          labels={{ close: t("common.close") }}
          onClose={() => setOpen(null)}
        >
          <Stack gap={4}>
            <p className="muted">
              {t("details.summary", {
                input: String(open.input_tokens),
                output: String(open.output_tokens),
                cached: String(open.cached_tokens),
                ttft: open.ttft_ms === null ? "—" : `${open.ttft_ms} ms`,
                took: `${open.took_ms} ms`,
              })}
            </p>
            <section className="details-part">
              <h3>{t("details.request")}</h3>
              {open.request ? <CodeBlock code={pretty(open.request)} language="json" labels={labels.codeBlock} /> : <span className="muted">—</span>}
            </section>
            {open.thinking && (
              <section className="details-part">
                <h3>{t("details.thinking")}</h3>
                <pre className="details-text">{open.thinking}</pre>
              </section>
            )}
            <section className="details-part">
              <h3>{t("details.response")}</h3>
              {open.response ? <pre className="details-text">{open.response}</pre> : <span className="muted">—</span>}
            </section>
          </Stack>
        </Drawer>
      )}
      {confirming && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("details.clearTitle")}
          labels={labels.dialog}
          confirmLabel={t("details.clear")}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void clearAll()}
        >
          {t("details.clearBody")}
        </Dialog>
      )}
    </Stack>
  );
}
