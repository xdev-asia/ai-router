import { useCallback, useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  SearchInput,
  Segmented,
  Stack,
  StatusDot,
  Tabs,
  type DataTableColumn,
} from "@xdev-asia/ui";
import { ApiError, api } from "../api";
import { RequestDetails } from "./RequestDetails";
import { apiOf } from "./Endpoint";
import { t, useLang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";

/** One line of GET /admin/logs (worker/logs.ts). It never holds a key or request content. */
export interface LogLine {
  id: number;
  /** Milliseconds since the epoch. */
  at: number;
  level: "info" | "warn" | "error";
  method: string;
  path: string;
  status: number;
  took_ms: number;
  system_id: string | null;
  model: string | null;
  message: string | null;
}

interface LogPage {
  /** Newest first. */
  logs: LogLine[];
  kept: { rows: number; minutes: number };
}

type Level = "all" | LogLine["level"];

/** How often the live tail asks for new lines. */
export const TAIL_MS = 3000;
/** The worker keeps this many lines (worker/logs.ts KEEP_ROWS); the page never holds more. */
const MAX_ROWS = 500;
const DEFAULT_KEPT = { rows: 500, minutes: 15 };

/** The path for one fetch: the filters, and `after` for lines newer than the one already shown. */
export function logsPath(level: Level, q: string, after?: number): string {
  const p = new URLSearchParams();
  if (level !== "all") p.set("level", level);
  if (q) p.set("q", q);
  if (after !== undefined) p.set("after", String(after));
  const s = p.toString();
  return s ? `/logs?${s}` : "/logs";
}

/** New lines on top of the shown ones, without repeats, newest first, at most MAX_ROWS. */
export function mergeLines(fresh: LogLine[], shown: LogLine[]): LogLine[] {
  const seen = new Set(shown.map((l) => l.id));
  return [...fresh.filter((l) => !seen.has(l.id)), ...shown].sort((a, b) => b.id - a.id).slice(0, MAX_ROWS);
}

const TONE = { info: "neutral", warn: "warn", error: "danger" } as const;
const ROW_LABEL: Record<LogLine["level"], StringKey> = { info: "logs.row.info", warn: "logs.row.warn", error: "logs.row.error" };

/** Logs: the console log, and the request details kept while Observability is on. */
export function Logs() {
  const [view, setView] = useState<"console" | "details">("console");
  return (
    <Stack gap={4}>
      <Tabs
        label={t("logs.tabs")}
        items={[
          { id: "console", label: t("logs.tab.console") },
          { id: "details", label: t("logs.tab.details") },
        ]}
        value={view}
        onChange={(v) => setView(v as "console" | "details")}
      />
      {view === "console" ? <ConsoleLog /> : <RequestDetails />}
    </Stack>
  );
}

/**
 * The console log: what the gateway did with each request. Filters run on the worker; the live tail
 * asks for lines newer than the top one every few seconds while the tab is visible.
 */
function ConsoleLog() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();

  const [level, setLevel] = useState<Level>("all");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LogLine[] | null>(null);
  const [kept, setKept] = useState(DEFAULT_KEPT);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tailFailed, setTailFailed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clearError, setClearError] = useState<{ title: string; detail?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  /** Bumped on every filter change, so an answer for old filters is dropped. */
  const generation = useRef(0);
  const latest = useRef<number | undefined>(undefined);

  // The search box filters on the worker; wait for typing to stop.
  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const gen = ++generation.current;
    setRows(null);
    setLoadFailed(false);
    setTailFailed(false);
    api<LogPage>(logsPath(level, q))
      .then((page) => {
        if (gen !== generation.current) return;
        setRows(page.logs.slice(0, MAX_ROWS));
        if (page.kept) setKept(page.kept);
        latest.current = page.logs[0]?.id;
      })
      .catch(() => {
        if (gen === generation.current) setLoadFailed(true);
      });
  }, [level, q, attempt]);

  const ready = rows !== null;
  useEffect(() => {
    if (paused || !ready) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const gen = generation.current;
      api<LogPage>(logsPath(level, q, latest.current ?? 0))
        .then((page) => {
          if (gen !== generation.current) return;
          setTailFailed(false);
          if (page.logs.length === 0) return;
          setRows((shown) => {
            const next = mergeLines(page.logs, shown ?? []);
            latest.current = next[0]?.id ?? latest.current;
            return next;
          });
        })
        .catch(() => {
          if (gen === generation.current) setTailFailed(true);
        });
    }, TAIL_MS);
    return () => clearInterval(timer);
  }, [paused, ready, level, q]);

  const clearFilters = useCallback(() => {
    setQuery("");
    setQ("");
    setLevel("all");
  }, []);

  const clearLog = async () => {
    setBusy(true);
    setClearError(null);
    try {
      await api("/logs", { method: "DELETE" });
      // Ids keep counting after a clear (AUTOINCREMENT), so `latest` stays a valid starting point for the tail.
      setRows([]);
      setConfirming(false);
      notify(t("logs.cleared"));
    } catch (e) {
      setClearError({ title: t("ux.logs.clearFailed"), detail: e instanceof ApiError ? t("ux.httpStatus", { status: String(e.status) }) : t("error.generic") });
    } finally {
      setBusy(false);
    }
  };

  const time = (at: number) =>
    new Date(at).toLocaleTimeString(lang === "vi" ? "vi-VN" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  const columns: DataTableColumn<LogLine>[] = [
    { key: "time", header: t("logs.col.time"), mono: true, width: "min", cell: (l) => time(l.at) },
    { key: "level", header: t("logs.col.level"), width: "min", cell: (l) => <StatusDot tone={TONE[l.level]} label={t(ROW_LABEL[l.level])} /> },
    { key: "request", header: t("logs.col.request"), mono: true, cell: (l) => `${l.method} ${l.path}` },
    { key: "api", header: t("logs.col.api"), width: "min", hideNarrow: true, cell: (l) => t(`endpoint.fmt.${apiOf(l.path)}`) },
    { key: "status", header: t("logs.col.status"), mono: true, align: "end", width: "min", cell: (l) => String(l.status) },
    { key: "message", header: t("logs.col.message"), cell: (l) => [l.model, l.message].filter(Boolean).join(" · ") || "—" },
    { key: "took", header: t("logs.col.took"), mono: true, align: "end", width: "min", hideNarrow: true, cell: (l) => `${l.took_ms} ms` },
    { key: "system", header: t("logs.col.system"), mono: true, hideNarrow: true, cell: (l) => l.system_id ?? "—" },
  ];

  const filtered = level !== "all" || q !== "";
  const levels: { value: Level; label: string }[] = [
    { value: "all", label: t("logs.level.all") },
    { value: "info", label: t("logs.level.info") },
    { value: "warn", label: t("logs.level.warn") },
    { value: "error", label: t("logs.level.error") },
  ];

  return (
    <Stack gap={4}>
      <Stack direction="row" justify="between" gap={3} wrap>
        <Stack direction="row" gap={3} wrap>
          <SearchInput
            size="sm"
            placeholder={t("logs.filter")}
            aria-label={t("logs.filter")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            labels={labels.searchInput}
          />
          <Segmented label={t("logs.level")} options={levels} value={level} onChange={(v) => setLevel(v as Level)} />
        </Stack>
        <Stack direction="row" gap={2} wrap>
          <StatusDot tone={paused ? "neutral" : "ok"} pulse={!paused} label={t(paused ? "logs.paused" : "logs.live")} />
          <Button size="sm" icon={paused ? "play" : "pause"} onClick={() => setPaused((p) => !p)}>
            {t(paused ? "logs.resume" : "logs.pause")}
          </Button>
          <Button size="sm" variant="ghost" icon="trash" disabled={!rows || rows.length === 0} onClick={() => setConfirming(true)}>
            {t("logs.clear")}
          </Button>
        </Stack>
      </Stack>
      {tailFailed && <Banner tone="warn" title={t("logs.tailFailed")} />}
      <Card flush>
        {loadFailed ? (
          <Banner tone="danger" title={t("error.load")} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t("common.retry")}</Button>} />
        ) : (
          <DataTable
            caption={t("logs.caption")}
            columns={columns}
            rows={rows ?? []}
            rowKey={(l) => String(l.id)}
            loading={rows === null}
            labels={labels.dataTable}
            empty={
              filtered ? (
                <EmptyState icon="search" title={t("logs.noMatch")} actions={<Button onClick={clearFilters}>{t("logs.clearFilters")}</Button>} />
              ) : (
                <EmptyState icon="activity" title={t("logs.empty")} hint={t("logs.emptyHint")} />
              )
            }
          />
        )}
      </Card>
      <p className="muted">{t("logs.kept", { rows: String(kept.rows), minutes: String(kept.minutes) })}</p>
      {confirming && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("logs.clearTitle")}
          labels={labels.dialog}
          confirmLabel={t("logs.clear")}
          busy={busy}
          onCancel={() => {
            setConfirming(false);
            setClearError(null);
          }}
          onConfirm={() => void clearLog()}
        >
          <Stack gap={2}>
            <span>{t("logs.clearBody")}</span>
            {clearError && (
              <Banner tone="danger" title={clearError.title}>
                {clearError.detail}
              </Banner>
            )}
          </Stack>
        </Dialog>
      )}
    </Stack>
  );
}
