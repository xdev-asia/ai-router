import {
  Banner,
  Button,
  Card,
  EmptyState,
  Grid,
  ListRow,
  Meter,
  Segmented,
  Skeleton,
  Stack,
  StatusDot,
} from "@xdev-asia/ui";
import { capTokens, useLoad, type Connection, type Provider, type System, type UsagePeriod, type UsageReport, type UsageRequest, type UsageSummary } from "../api";
import { formatNumber, t, useLang, type Lang, type StringKey } from "../i18n";
import { useHashParams } from "../url-state";
import { BarsCard, OverTime, Status, Totals, formatAgo, tzMinutes } from "./Usage";

/** The periods the overview offers; Usage has the rest. */
const PERIODS = ["today", "7d", "30d"] as const satisfies readonly UsagePeriod[];
const PERIOD_DEFAULT = { period: "today" };
const PERIOD_ALLOWED = { period: [...PERIODS] };
/** A system at or above this share of its monthly cap needs a look. */
export const CAP_WARN = 80;
/** An account's last failure counts while it is this recent and no request has gone through since. */
const ERROR_WINDOW_S = 24 * 3600;
const TOP_MODELS = 5;
const RECENT_ERRORS = 5;

/** One thing the owner should look at, most urgent first. */
export interface Attention {
  key: string;
  tone: "warn" | "danger";
  title: string;
  detail: string;
  href: string;
}

const locale = (lang: Lang) => (lang === "vi" ? "vi-VN" : "en-US");

/** "in 4 min": how long until a moment in the future. */
export function formatIn(at: number, lang: Lang, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(at - now));
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto", style: "short" });
  if (s < 60) return rtf.format(Math.max(1, s), "second");
  if (s < 3600) return rtf.format(Math.ceil(s / 60), "minute");
  if (s < 86_400) return rtf.format(Math.ceil(s / 3600), "hour");
  return rtf.format(Math.ceil(s / 86_400), "day");
}

/** Tokens each system used this month, against the cap (the same sum the gateway checks). */
export function monthUsed(report: UsageReport | null): Map<string, number> {
  const used = new Map<string, number>();
  for (const r of report?.rows ?? []) used.set(r.system_id, (used.get(r.system_id) ?? 0) + capTokens(r));
  return used;
}

/** A system's share of its cap, 0 and up (over 100 when one request went past it); null without a cap. */
export function capShare(s: System, used: number): number | null {
  if (s.monthly_token_cap === null) return null;
  return s.monthly_token_cap === 0 ? 100 : (used / s.monthly_token_cap) * 100;
}

/**
 * What needs a look: accounts set aside or failing, and systems near or at their cap. Disabled accounts and
 * systems are left out, as the owner turned them off on purpose.
 */
export function attentionItems(
  connections: Connection[],
  systems: System[],
  used: Map<string, number>,
  providerName: ReadonlyMap<string, string>,
  lang: Lang,
  now = Date.now() / 1000,
): Attention[] {
  const items: Attention[] = [];
  for (const c of connections) {
    if (c.disabled) continue;
    const who = `${providerName.get(c.provider) ?? c.provider} · ${c.name}`;
    const href = `#/providers/${c.provider}`;
    if (c.cooldown_until > now) {
      items.push({ key: `cool:${c.id}`, tone: "warn", title: who, detail: t("overview.attn.cooling", { when: formatIn(c.cooldown_until, lang, now) }), href });
    } else if (c.last_error && c.last_error_at && now - c.last_error_at < ERROR_WINDOW_S && (c.last_used_at === null || c.last_error_at >= c.last_used_at)) {
      items.push({ key: `err:${c.id}`, tone: "danger", title: who, detail: t("overview.attn.failing", { when: formatAgo(c.last_error_at, lang, now), message: c.last_error }), href });
    }
  }
  for (const s of systems) {
    if (s.disabled) continue;
    const share = capShare(s, used.get(s.id) ?? 0);
    if (share === null || share < CAP_WARN) continue;
    const n = formatNumber(Math.floor(share));
    items.push({
      key: `cap:${s.id}`,
      tone: share >= 100 ? "danger" : "warn",
      title: s.name,
      detail: t(share >= 100 ? "overview.attn.capped" : "overview.attn.nearCap", { n }),
      href: "#/systems",
    });
  }
  return items.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "danger" ? -1 : 1));
}

/** The landing page: what needs a look, then the period's totals, its chart, caps, top models and recent failures. */
export function Overview() {
  const [lang] = useLang();
  const [params, setParams] = useHashParams("#/overview", PERIOD_DEFAULT, PERIOD_ALLOWED);
  const period = params.period as UsagePeriod;
  const [providers] = useLoad<Provider[]>("/providers");
  const [connections, reloadConnections] = useLoad<Connection[]>("/connections");
  const [systems, reloadSystems] = useLoad<System[]>("/systems");
  const [month, reloadMonth] = useLoad<UsageReport>("/usage");
  const [report, reloadReport] = useLoad<UsageSummary>(`/usage/summary?period=${period}${period === "today" ? `&tz=${tzMinutes()}` : ""}`);

  const providerName = new Map((providers.status === "ready" ? providers.data : []).map((p) => [p.id, p.name]));
  const used = monthUsed(month.status === "ready" ? month.data : null);
  const data = report.status === "ready" ? report.data : null;
  const loading = report.status === "loading";
  const empty = <EmptyState size="inline" icon="activity" title={t("usage.noRequests")} />;

  return (
    <Stack gap={4}>
      <Segmented
        label={t("usage.period")}
        value={period}
        onChange={(v) => setParams({ period: v })}
        options={PERIODS.map((p) => ({ value: p, label: t(`usage.period.${p}` as StringKey) }))}
      />
      <AttentionCard
        loading={connections.status === "loading" || systems.status === "loading" || month.status === "loading"}
        failed={connections.status === "error" || systems.status === "error" || month.status === "error"}
        onRetry={() => {
          reloadConnections();
          reloadSystems();
          reloadMonth();
        }}
        items={
          connections.status === "ready" && systems.status === "ready"
            ? attentionItems(connections.data, systems.data, used, providerName, lang)
            : []
        }
      />
      {report.status === "error" ? (
        <Banner tone="danger" title={t("error.load")} action={<Button onClick={reloadReport}>{t("common.retry")}</Button>} />
      ) : (
        <Totals data={data} loading={loading} />
      )}
      <OverTime period={period} />
      <Grid columns={{ base: 1, lg: 2 }} gap={3}>
        <CapsCard systems={systems.status === "ready" ? systems.data : null} used={used} loading={systems.status === "loading" || month.status === "loading"} />
        <BarsCard
          title={t("usage.topModels")}
          chartLabel={(m) => t("usage.bars.topModels", { metric: t(`usage.metric.${m}` as StringKey) })}
          rows={(data?.by_model ?? []).map((r) => ({ key: `${r.provider}/${r.model ?? ""}`, label: r.model ?? "—", row: r }))}
          limit={TOP_MODELS}
          loading={loading}
          empty={empty}
        />
      </Grid>
      <RecentErrors providerName={providerName} />
    </Stack>
  );
}

function AttentionCard({ items, loading, failed, onRetry }: { items: Attention[]; loading: boolean; failed: boolean; onRetry: () => void }) {
  const title = items.length > 0 ? t("overview.attn.titleN", { n: formatNumber(items.length) }) : t("overview.attn.title");
  return (
    <Card title={title} headingLevel={2} flush={!loading && !failed && items.length > 0}>
      {loading && <Skeleton lines={2} announce labels={{ loading: t("loading") }} />}
      {!loading && failed && <Banner tone="danger" title={t("error.load")} action={<Button onClick={onRetry}>{t("common.retry")}</Button>} />}
      {!loading && !failed && items.length === 0 && <EmptyState size="inline" icon="check" title={t("overview.attn.none")} />}
      {!loading && !failed && items.length > 0 && (
        <ul className="overview-list">
          {items.map((a) => (
            <ListRow
              key={a.key}
              as="li"
              leading={<StatusDot tone={a.tone} label={t(a.tone === "danger" ? "overview.attn.danger" : "overview.attn.warn")} />}
              title={a.title}
              meta={a.detail}
              trailing={
                <Button size="sm" variant="secondary" href={a.href}>
                  {t("overview.open")}
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function CapsCard({ systems, used, loading }: { systems: System[] | null; used: Map<string, number>; loading: boolean }) {
  const capped = (systems ?? [])
    .filter((s) => !s.disabled && s.monthly_token_cap !== null)
    .map((s) => ({ s, n: used.get(s.id) ?? 0, share: capShare(s, used.get(s.id) ?? 0) ?? 0 }))
    .sort((a, b) => b.share - a.share);
  return (
    <Card title={t("overview.caps.title")} subtitle={t("overview.caps.subtitle")} headingLevel={2} actions={<Button size="sm" href="#/systems">{t("overview.caps.manage")}</Button>}>
      {loading && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
      {!loading && capped.length === 0 && <EmptyState size="inline" icon="key" title={t("overview.caps.none")} />}
      {!loading && capped.length > 0 && (
        <ul className="overview-caps">
          {capped.map(({ s, n, share }) => (
            <li key={s.id} className="overview-cap">
              <span className="overview-cap-name">{s.name}</span>
              <Meter
                fill
                value={Math.min(100, share)}
                tone={share >= 100 ? "danger" : share >= CAP_WARN ? "warn" : "ok"}
                label={s.name}
                valueText={t("systems.used", { used: formatNumber(n), cap: formatNumber(s.monthly_token_cap ?? 0) })}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentErrors({ providerName }: { providerName: ReadonlyMap<string, string> }) {
  const [lang] = useLang();
  const [list, reload] = useLoad<{ rows: UsageRequest[] }>(`/usage/requests?status=error&limit=${RECENT_ERRORS}`);
  const rows = list.status === "ready" ? list.data.rows : [];
  return (
    <Card
      title={t("overview.errors.title")}
      headingLevel={2}
      flush={rows.length > 0}
      actions={<Button size="sm" href="#/usage?tab=details">{t("usage.viewAll")}</Button>}
    >
      {list.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
      {list.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {list.status === "ready" && rows.length === 0 && <EmptyState size="inline" icon="check" title={t("overview.errors.none")} />}
      {rows.length > 0 && (
        <ul className="overview-list">
          {rows.map((r) => (
            <ListRow
              key={r.id}
              as="li"
              leading={<Status code={r.status} />}
              title={r.model ?? providerName.get(r.provider) ?? r.provider}
              meta={`${providerName.get(r.provider) ?? r.provider} · ${r.system_id} · ${formatAgo(r.at, lang)}`}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
