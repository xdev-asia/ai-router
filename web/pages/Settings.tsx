import { useEffect, useState } from "react";
import { Banner, Button, Card, Dialog, Field, FileDrop, Grid, Segmented, Select, SettingRow, Skeleton, Stack, StatusDot, Switch } from "@xdev-asia/ui";
import type { ThemePreference } from "@xdev-asia/ui";
import { ApiError, COMBO_STRATEGIES, api, useLoad, type ComboStrategy } from "../api";
import { t, useLang, type Lang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { useTheme } from "../theme";
import { useTranslatorShown } from "../translator-pref";
import { ui } from "../ui-labels";

/** What GET /admin/settings/info says: whether each Worker secret is set, never its value. */
export interface SettingsInfo {
  admin_token: boolean;
  oidc: boolean;
  console_emails: number;
  connections_key: boolean;
  codex_relay: boolean;
}

interface ComboSettings {
  strategy: ComboStrategy;
  sticky_limit: number;
}

/** The tables a backup holds (worker/backup.ts BACKUP_TABLES). */
export const BACKUP_TABLES = ["combo", "model_alias", "model_disabled", "model_custom", "price", "setting", "provider_setting"] as const;

const STRATEGY_LABEL: Record<ComboStrategy, StringKey> = {
  fallback: "combos.strategy.fallback",
  "round-robin": "combos.strategy.roundRobin",
  smart: "combos.strategy.smart",
  fusion: "combos.strategy.fusion",
};
const STRATEGY_HINT: Record<ComboStrategy, StringKey> = {
  fallback: "combos.strategyHint.fallback",
  "round-robin": "combos.strategyHint.roundRobin",
  smart: "combos.strategyHint.smart",
  fusion: "combos.strategyHint.fusion",
};

const MAX_BACKUP = 5 * 1024 * 1024;


/** How long the gateway waits for a provider (GET /admin/timeouts, worker/timeouts.ts). */
interface Timeouts {
  first_byte_s: number;
  idle_s: number;
}
type TimeoutKey = keyof Timeouts;
const TIMEOUT_ROWS: { key: TimeoutKey; label: StringKey; hint: StringKey }[] = [
  { key: "first_byte_s", label: "prefs.timeoutFirstByte", hint: "prefs.timeoutFirstByteHint" },
  { key: "idle_s", label: "prefs.timeoutIdle", hint: "prefs.timeoutIdleHint" },
];

/** The worker's rule: 0 (off), or a whole number of seconds from 10 to 3600. */
export function timeoutOk(text: string): boolean {
  const v = text.trim();
  if (!/^\d+$/.test(v)) return false;
  const n = Number(v);
  return n === 0 || (n >= 10 && n <= 3600);
}

/** The two upstream limits, each with its own field and Save (docs/add/upstream-timeouts.md). */
function TimeoutsCard() {
  const notify = useNotify();
  const [load, reload] = useLoad<Timeouts>("/timeouts");
  const [saved, setSaved] = useState<Timeouts | null>(null);
  const [draft, setDraft] = useState<Record<TimeoutKey, string>>({ first_byte_s: "", idle_s: "" });
  const [bad, setBad] = useState<Partial<Record<TimeoutKey, boolean>>>({});
  const [saving, setSaving] = useState<TimeoutKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (load.status !== "ready") return;
    setSaved(load.data);
    setDraft({ first_byte_s: String(load.data.first_byte_s), idle_s: String(load.data.idle_s) });
  }, [load]);

  async function save(key: TimeoutKey) {
    if (!timeoutOk(draft[key])) {
      setBad((b) => ({ ...b, [key]: true }));
      return;
    }
    setBad((b) => ({ ...b, [key]: false }));
    setSaving(key);
    setError(null);
    try {
      const next = await api<Timeouts>("/timeouts", { method: "PUT", body: { [key]: Number(draft[key].trim()) } });
      setSaved(next);
      setDraft((d) => ({ ...d, [key]: String(next[key]) }));
      notify(t("prefs.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 400) setBad((b) => ({ ...b, [key]: true }));
      else setError(t("error.generic"));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card title={t("prefs.timeouts")} subtitle={t("prefs.timeoutsHint")} headingLevel={2}>
      {load.status === "loading" && <Skeleton lines={2} announce labels={{ loading: t("loading") }} />}
      {load.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {saved && (
        <Stack gap={3}>
          {error && <Banner tone="danger" title={error} />}
          {TIMEOUT_ROWS.map(({ key, label, hint }) => (
            <SettingRow
              key={key}
              label={t(label)}
              description={`${t(hint)} ${t("prefs.timeoutRange")}`}
              control={
                <div className="prefs-inline">
                  <Field
                    label={t(label)}
                    hideLabel
                    inputMode="numeric"
                    value={draft[key]}
                    autoComplete="off"
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    error={bad[key] ? t("prefs.timeoutInvalid") : undefined}
                  />
                  <Button aria-label={t("prefs.saveNamed", { name: t(label) })} disabled={saving !== null || draft[key].trim() === String(saved[key])} onClick={() => void save(key)}>
                    {t("common.save")}
                  </Button>
                </div>
              }
            />
          ))}
        </Stack>
      )}
    </Card>
  );
}

/** What GET /admin/sso says: the xDev ID client sign-in uses and where it comes from, never its secret. */
export interface SsoView {
  source: "settings" | "env" | "none";
  issuer: string;
  client_id: string;
  secret_set: boolean;
  redirect_uri: string;
}

type SsoField = "issuer" | "client_id" | "secret";
type SsoDraft = Record<SsoField, string>;

/** The fields PUT /admin/sso would refuse (worker/sso.ts), so nothing is sent for them. */
export function validateSso(d: SsoDraft, secretSet: boolean): Partial<Record<SsoField, StringKey>> {
  const bad: Partial<Record<SsoField, StringKey>> = {};
  const issuer = d.issuer.trim();
  let u: URL | null;
  try {
    u = new URL(issuer);
  } catch {
    u = null;
  }
  if (!u || issuer.length > 500 || u.protocol !== "https:" || u.username || u.password || issuer.includes("?") || issuer.includes("#")) {
    bad.issuer = "prefs.ssoIssuerBad";
  }
  const client = d.client_id.trim();
  if (!client || client.length > 200) bad.client_id = "prefs.ssoClientBad";
  if (d.secret.length > 4096) bad.secret = "prefs.ssoSecretLong";
  else if (!d.secret.trim() && !secretSet) bad.secret = "prefs.ssoSecretNeeded";
  return bad;
}

const SSO_STATUS: Record<SsoView["source"], StringKey> = { settings: "prefs.ssoOnSettings", env: "prefs.ssoOnEnv", none: "prefs.ssoOff" };

/** The xDev ID client the console signs in with (FR-SET-17 to FR-SET-21). The secret is write-only. */
function SsoCard() {
  const notify = useNotify();
  const [lang] = useLang();
  const labels = ui(lang);
  const [load, reload] = useLoad<SsoView>("/sso");
  const [saved, setSaved] = useState<SsoView | null>(null);
  const [draft, setDraft] = useState<SsoDraft>({ issuer: "", client_id: "", secret: "" });
  const [bad, setBad] = useState<Partial<Record<SsoField, StringKey>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StringKey | null>(null);
  const [confirmEnv, setConfirmEnv] = useState(false);

  const show = (v: SsoView) => {
    setSaved(v);
    setDraft({ issuer: v.issuer, client_id: v.client_id, secret: "" });
    setBad({});
  };

  useEffect(() => {
    if (load.status === "ready") show(load.data);
  }, [load]);

  const on = saved !== null && saved.issuer !== "" && saved.client_id !== "" && saved.secret_set;
  const changed = saved !== null && (draft.issuer.trim() !== saved.issuer || draft.client_id.trim() !== saved.client_id || draft.secret.trim() !== "");
  const edit = (field: SsoField) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [field]: e.target.value }));

  async function save() {
    if (!saved) return;
    const found = validateSso(draft, saved.secret_set);
    setBad(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { issuer: draft.issuer.trim(), client_id: draft.client_id.trim() };
      if (draft.secret.trim()) body.secret = draft.secret.trim();
      show(await api<SsoView>("/sso", { method: "PUT", body }));
      notify(t("prefs.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 409) setError("prefs.ssoNoKey");
      else if (e instanceof ApiError && e.status === 400) setError("prefs.ssoRefused");
      else setError("error.generic");
    } finally {
      setBusy(false);
    }
  }

  async function useEnv() {
    setBusy(true);
    setError(null);
    try {
      show(await api<SsoView>("/sso", { method: "DELETE" }));
      notify(t("prefs.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError("error.generic");
    } finally {
      setConfirmEnv(false);
      setBusy(false);
    }
  }

  async function copyRedirect(uri: string) {
    try {
      await navigator.clipboard.writeText(uri);
      notify(t("prefs.ssoRedirectCopied"));
    } catch {
      notify(t("skills.copyFailed"));
    }
  }

  return (
    <Card title={t("prefs.sso")} subtitle={t("prefs.ssoHint")} headingLevel={2}>
      {load.status === "loading" && <Skeleton lines={4} announce labels={{ loading: t("loading") }} />}
      {load.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {saved && (
        <Stack gap={3}>
          {error && <Banner tone="danger" title={t(error)} />}
          <SettingRow label={t("prefs.ssoStatus")} description={t("prefs.ssoStatusHint")} control={<StatusDot tone={on ? "ok" : "neutral"} label={t(on ? SSO_STATUS[saved.source] : "prefs.ssoOff")} />} />
          <SettingRow
            label={t("prefs.ssoRedirect")}
            description={
              <>
                {t("prefs.ssoRedirectHint")} <code className="prefs-uri">{saved.redirect_uri}</code>
              </>
            }
            control={
              <Button aria-label={t("prefs.ssoRedirectCopy")} onClick={() => void copyRedirect(saved.redirect_uri)}>
                {t("common.copy")}
              </Button>
            }
          />
          <Field
            label={t("prefs.ssoIssuer")}
            hint={t("prefs.ssoIssuerHint")}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={draft.issuer}
            onChange={edit("issuer")}
            error={bad.issuer ? t(bad.issuer) : undefined}
          />
          <Field
            label={t("prefs.ssoClient")}
            autoComplete="off"
            spellCheck={false}
            value={draft.client_id}
            onChange={edit("client_id")}
            error={bad.client_id ? t(bad.client_id) : undefined}
          />
          <Field
            label={t("prefs.ssoSecret")}
            hint={t("prefs.ssoSecretHint")}
            type="password"
            autoComplete="off"
            placeholder={saved.secret_set ? t("prefs.ssoSecretKept") : undefined}
            value={draft.secret}
            onChange={edit("secret")}
            error={bad.secret ? t(bad.secret) : undefined}
          />
          <div className="prefs-actions">
            {saved.source === "settings" && (
              <Button disabled={busy} onClick={() => setConfirmEnv(true)}>
                {t("prefs.ssoUseEnv")}
              </Button>
            )}
            <Button variant="primary" aria-label={t("prefs.saveNamed", { name: t("prefs.sso") })} disabled={busy || !changed} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        </Stack>
      )}
      {confirmEnv && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("prefs.ssoUseEnvTitle")}
          labels={labels.dialog}
          confirmLabel={t("prefs.ssoUseEnv")}
          busy={busy}
          onCancel={() => setConfirmEnv(false)}
          onConfirm={() => void useEnv()}
        >
          <p>{t("prefs.ssoUseEnvBody")}</p>
        </Dialog>
      )}
    </Card>
  );
}

/** The tables of a backup file and their rows, or null when the file is not one. */
export function readBackup(text: string): Record<string, unknown[]> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const b = v as { version?: unknown; tables?: unknown };
  if (b.version !== 1 || !b.tables || typeof b.tables !== "object" || Array.isArray(b.tables)) return null;
  const tables = b.tables as Record<string, unknown>;
  const names = Object.keys(tables);
  if (names.length === 0 || !names.every((n) => (BACKUP_TABLES as readonly string[]).includes(n) && Array.isArray(tables[n]))) return null;
  return tables as Record<string, unknown[]>;
}

function fileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** Set or not set, never the value. */
function SecretState({ set, label }: { set: boolean; label?: string }) {
  return <StatusDot tone={set ? "ok" : "neutral"} label={set ? (label ?? t("prefs.set")) : t("prefs.notSet")} />;
}

/**
 * The console's own settings page (without what a Worker has no use for: a database file,
 * shutting down, a login password). Appearance stays in this browser; the rest is the gateway's.
 */
export function Settings() {
  const [lang, setLang] = useLang();
  const [theme, setTheme] = useTheme();
  const [translatorShown, setTranslatorShown] = useTranslatorShown();
  const labels = ui(lang);
  const notify = useNotify();
  const [info, reloadInfo] = useLoad<SettingsInfo>("/settings/info");
  const [combo, reloadCombo] = useLoad<ComboSettings>("/combo-settings");
  const [routing, setRouting] = useState<ComboSettings | null>(null);
  const [sticky, setSticky] = useState("");
  const [stickyBad, setStickyBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backup, setBackup] = useState<Record<string, unknown[]> | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (combo.status !== "ready") return;
    setRouting(combo.data);
    setSticky(String(combo.data.sticky_limit));
  }, [combo]);

  async function run(action: () => Promise<void>, onError?: (e: unknown) => boolean) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (!onError?.(e)) (backup ? setDialogError : setError)(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const saveRouting = (body: Partial<ComboSettings>) =>
    run(async () => {
      const next = await api<ComboSettings>("/combo-settings", { method: "PUT", body });
      setRouting(next);
      setSticky(String(next.sticky_limit));
      notify(t("prefs.saved"));
    });

  function saveSticky() {
    const n = Number(sticky.trim());
    if (!/^\d+$/.test(sticky.trim()) || n < 1 || n > 1000) {
      setStickyBad(true);
      return;
    }
    setStickyBad(false);
    void saveRouting({ sticky_limit: n });
  }

  const exportBackup = () =>
    run(async () => {
      const data = await api<unknown>("/backup");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      if (typeof URL.createObjectURL === "function") {
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = "ai-router-backup.json";
        a.click();
        URL.revokeObjectURL(href);
      }
      notify(t("prefs.exported"));
    });

  async function pick(files: File[]) {
    const file = files[0];
    if (!file) return;
    setImportError(null);
    const tables = readBackup(await fileText(file).catch(() => ""));
    if (!tables) {
      setImportError(t("prefs.importBad"));
      return;
    }
    setDialogError(null);
    setBackup(tables);
  }

  const closeImport = () => {
    setBackup(null);
    setDialogError(null);
  };

  const importBackup = (tables: Record<string, unknown[]>) =>
    run(
      async () => {
        const r = await api<{ ok: true; rows: number }>("/backup", { body: { version: 1, tables } });
        closeImport();
        notify(t("prefs.imported", { n: String(r.rows) }));
        reloadCombo();
      },
      (e) => {
        if (!(e instanceof ApiError && e.detail)) return false;
        closeImport();
        setImportError(t("prefs.importFailed", { message: e.detail }));
        return true;
      },
    );

  const themes: { value: ThemePreference; label: string }[] = [
    { value: "light", label: t("theme.light") },
    { value: "dark", label: t("theme.dark") },
    { value: "system", label: t("theme.system") },
  ];
  const langs: { value: Lang; label: string }[] = [
    { value: "en", label: "English" },
    { value: "vi", label: "Tiếng Việt" },
  ];

  return (
    <Stack gap={4}>
      {error && <Banner tone="danger" title={error} />}
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        <Card title={t("prefs.appearance")} headingLevel={2}>
          <Stack gap={3}>
            <SettingRow
              label={t("prefs.theme")}
              description={t("prefs.themeHint")}
              control={<Segmented label={t("prefs.theme")} options={themes} value={theme} onChange={(v) => setTheme(v as ThemePreference)} />}
            />
            <SettingRow
              label={t("prefs.language")}
              description={t("prefs.languageHint")}
              control={<Segmented label={t("prefs.language")} options={langs} value={lang} onChange={(v) => setLang(v as Lang)} />}
            />
            <SettingRow
              label={t("prefs.translator")}
              description={t("prefs.translatorHint")}
              controlId="prefs-translator"
              control={<Switch id="prefs-translator" checked={translatorShown} onChange={(e) => setTranslatorShown(e.target.checked)} />}
            />
          </Stack>
        </Card>

        <Card title={t("prefs.routing")} subtitle={t("prefs.routingHint")} headingLevel={2}>
          {combo.status === "loading" && <Skeleton lines={2} announce labels={{ loading: t("loading") }} />}
          {combo.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reloadCombo}>{t("common.retry")}</Button>} />}
          {routing && (
            <Stack gap={3}>
              <SettingRow
                label={t("prefs.strategy")}
                description={t(STRATEGY_HINT[routing.strategy])}
                controlId="prefs-strategy"
                control={
                  <Select
                    id="prefs-strategy"
                    aria-describedby="prefs-strategy-hint"
                    value={routing.strategy}
                    disabled={busy}
                    options={COMBO_STRATEGIES.map((s) => ({ value: s, label: t(STRATEGY_LABEL[s]) }))}
                    onChange={(e) => void saveRouting({ strategy: e.target.value as ComboStrategy })}
                  />
                }
              />
              {routing.strategy === "round-robin" && (
                <SettingRow
                  label={t("prefs.sticky")}
                  description={t("prefs.stickyHint")}
                  control={
                    <div className="prefs-inline">
                      <Field
                        label={t("prefs.sticky")}
                        hideLabel
                        inputMode="numeric"
                        value={sticky}
                        autoComplete="off"
                        onChange={(e) => setSticky(e.target.value)}
                        error={stickyBad ? t("prefs.stickyBad") : undefined}
                      />
                      <Button disabled={busy || sticky.trim() === String(routing.sticky_limit)} onClick={saveSticky}>
                        {t("common.save")}
                      </Button>
                    </div>
                  }
                />
              )}
            </Stack>
          )}
        </Card>

        <TimeoutsCard />

        <Card title={t("prefs.signIn")} subtitle={t("prefs.signInHint")} headingLevel={2}>
          {info.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
          {info.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reloadInfo}>{t("common.retry")}</Button>} />}
          {info.status === "ready" && (
            <Stack gap={3}>
              <SettingRow label={t("prefs.adminToken")} description={t("prefs.adminTokenHint")} control={<SecretState set={info.data.admin_token} />} />
              <SettingRow
                label={t("prefs.emails")}
                description={t("prefs.emailsHint")}
                control={<SecretState set={info.data.console_emails > 0} label={t("prefs.emailsCount", { n: String(info.data.console_emails) })} />}
              />
            </Stack>
          )}
        </Card>

        <SsoCard />

        <Card title={t("prefs.gateway")} headingLevel={2}>
          {info.status === "loading" && <Skeleton lines={2} announce labels={{ loading: t("loading") }} />}
          {info.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reloadInfo}>{t("common.retry")}</Button>} />}
          {info.status === "ready" && (
            <Stack gap={3}>
              <SettingRow label={t("prefs.connectionsKey")} description={t("prefs.connectionsKeyHint")} control={<SecretState set={info.data.connections_key} />} />
              <SettingRow label={t("prefs.codexRelay")} description={t("prefs.codexRelayHint")} control={<SecretState set={info.data.codex_relay} />} />
            </Stack>
          )}
        </Card>

        <Card title={t("prefs.backup")} subtitle={t("prefs.backupHint")} headingLevel={2}>
          <Stack gap={3}>
            <SettingRow
              label={t("prefs.export")}
              description={t("prefs.exportHint")}
              control={
                <Button icon="download" disabled={busy} onClick={() => void exportBackup()}>
                  {t("prefs.export")}
                </Button>
              }
            />
            <SettingRow label={t("prefs.import")} description={t("prefs.importHint")} />
            <FileDrop
              label={t("prefs.import")}
              accept=".json,application/json"
              maxSize={MAX_BACKUP}
              disabled={busy}
              onFiles={(files) => void pick(files)}
              labels={{
                drop: t("prefs.drop"),
                browse: t("prefs.browse"),
                limits: () => t("prefs.limits"),
                rejected: (name) => t("prefs.rejected", { name }),
              }}
            />
            {importError && <Banner tone="danger" title={importError} />}
          </Stack>
        </Card>
      </Grid>
      {backup && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("prefs.importTitle")}
          labels={labels.dialog}
          confirmLabel={t("prefs.importConfirm")}
          busy={busy}
          onCancel={closeImport}
          onConfirm={() => void importBackup(backup)}
        >
          {dialogError && <Banner tone="danger" title={dialogError} />}
          <p>{t("prefs.importBody")}</p>
          <ul className="prefs-tables">
            {Object.entries(backup).map(([table, rows]) => (
              <li key={table}>{t("prefs.importRows", { table, n: String(rows.length) })}</li>
            ))}
          </ul>
        </Dialog>
      )}
    </Stack>
  );
}
