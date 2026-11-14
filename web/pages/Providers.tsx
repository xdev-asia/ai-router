import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  FormDialog,
  Grid,
  Icon,
  IconButton,
  ListRow,
  Emblem,
  MenuButton,
  PairingCode,
  ResourceCard,
  Select,
  ShellTitle,
  Skeleton,
  SortableList,
  Stack,
  StatusDot,
  Switch,
  Tabs,
  Textarea,
  moveItem,
} from "@xdev-asia/ui";
import { ApiError, api, useLoad, type Connection, type Provider, type ProviderSetting } from "../api";
import { t, useLang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { providerLogo } from "../provider-logos";
import { ProviderModelsCard } from "./ProviderModels";
import { useShellTitle } from "../shell";
import { ui } from "../ui-labels";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const isCooling = (c: Connection) => !c.disabled && c.cooldown_until > nowSeconds();

type Filter = "all" | "connected" | "error" | "none";
const FILTERS: Filter[] = ["all", "connected", "error", "none"];

/** How the providers are grouped on the page, in this order; a group with no provider is not shown. */
const SECTIONS: { kind: string; title: StringKey; hint?: StringKey }[] = [
  { kind: "custom", title: "providers.section.custom", hint: "providers.section.customHint" },
  { kind: "oauth", title: "providers.section.oauth" },
  { kind: "free", title: "providers.section.free", hint: "providers.section.freeHint" },
  { kind: "api_key", title: "providers.section.api_key" },
];

/** The section a provider's card is in: the owner's own first, free tiers apart from the other API-key providers. */
const sectionOf = (p: Provider): string => (p.custom ? "custom" : p.free_tier ? "free" : (p.auth[0] ?? "api_key"));

/** How many connection tests Test all runs at once. */
const TEST_ALL_LIMIT = 3;

/** Runs `fn` on each item, at most `limit` at a time, and counts the outcomes; a throw counts as failed. */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<boolean>,
  onProgress?: (done: number) => void,
): Promise<{ ok: number; failed: number }> {
  let next = 0;
  let done = 0;
  let ok = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      let good = false;
      try {
        good = await fn(item);
      } catch {
        good = false;
      }
      if (good) ok++;
      done++;
      onProgress?.(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return { ok, failed: items.length - ok };
}

export type CustomFormat = "openai" | "anthropic";
export interface CustomProviderForm {
  id: string;
  name: string;
  format: CustomFormat;
  base_url: string;
}
type CustomErrors = Partial<Record<"id" | "name" | "base_url", StringKey>>;

const CUSTOM_ID = /^[a-z][a-z0-9-]{1,31}$/;

/** An https URL with no credentials, query or fragment, as the gateway takes it (worker/custom-providers.ts). */
function httpsBase(v: string): boolean {
  if (v.length > 500) return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** What is wrong with each field of the custom provider dialog; empty when all are right. The id is fixed once created. */
export function validateCustomProvider(f: CustomProviderForm, creating: boolean): CustomErrors {
  const errors: CustomErrors = {};
  if (creating && !CUSTOM_ID.test(f.id.trim())) errors.id = "providers.custom.idBad";
  const name = f.name.trim();
  if (name === "") errors.name = "providers.nameRequired";
  else if (name.length > 100) errors.name = "providers.custom.nameLong";
  if (!httpsBase(f.base_url)) errors.base_url = "providers.custom.baseUrlBad";
  return errors;
}

/** A proxy pool, as GET /admin/proxy-pools lists it (only what this page uses). */
type Pool = { id: string; name: string };

function matches(filter: Filter, accounts: Connection[]): boolean {
  if (filter === "connected") return accounts.some((a) => !a.disabled);
  if (filter === "error") return accounts.some(isCooling);
  if (filter === "none") return accounts.length === 0;
  return true;
}

/** What a provider has, under its name: connections in use, those set aside, or where its key comes from. */
function ProviderStatus({ provider, accounts }: { provider: Provider; accounts: Connection[] }) {
  if (accounts.length === 0) return <>{provider.env_key ? t("providers.envKey") : t("providers.none")}</>;
  if (accounts.every((a) => a.disabled)) return <StatusDot tone="neutral" label={t("providers.allOff")} />;
  const cooling = accounts.filter(isCooling).length;
  const connected = accounts.filter((a) => !a.disabled).length - cooling;
  return (
    <span className="provider-status">
      {connected > 0 && <StatusDot tone="ok" label={t("providers.connected", { n: String(connected) })} />}
      {cooling > 0 && <StatusDot tone="warn" label={t("providers.setAside", { n: String(cooling) })} />}
    </span>
  );
}

/**
 * Providers: a search field and a status filter, then one section per kind of
 * provider, each a grid of cards. A card opens the provider's connections; its switch turns them all off or on.
 */
export function Providers({ query = "" }: { query?: string }) {
  useLang();
  const [providers, reloadProviders] = useLoad<Provider[]>("/providers");
  const [connections, reloadConnections] = useLoad<Connection[]>("/connections");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notify = useNotify();
  /** The custom provider dialog, open with this format preset. */
  const [adding, setAdding] = useState<CustomFormat | null>(null);
  /** The section whose connections Test all is checking, and how far it got. */
  const [testing, setTesting] = useState<{ kind: string; done: number; n: number } | null>(null);
  /** The last Test all that had failures, shown in its section until the next one. */
  const [summary, setSummary] = useState<{ kind: string; ok: number; failed: number } | null>(null);
  const reload = () => {
    reloadProviders();
    reloadConnections();
  };

  /** Tests each connection at its provider, a few at a time; all fine is a toast, any failure a banner in the section. */
  async function testAll(kind: string, targets: Connection[]) {
    setSummary(null);
    setTesting({ kind, done: 0, n: targets.length });
    const r = await runLimited(
      targets,
      TEST_ALL_LIMIT,
      async (a) => (await api<{ ok: boolean }>(`/connections/${encodeURIComponent(a.id)}/test`, { method: "POST" })).ok === true,
      (done) => setTesting({ kind, done, n: targets.length }),
    );
    setTesting(null);
    if (r.failed === 0) notify(t("providers.testAllDone", { n: String(r.ok) }));
    else setSummary({ kind, ...r });
    reloadConnections();
  }

  /** Off when any connection is on, else on: one PATCH per connection that has to change. */
  async function toggle(accounts: Connection[]) {
    const disabled = accounts.some((a) => !a.disabled);
    setBusy(true);
    setError(null);
    try {
      for (const a of accounts.filter((x) => x.disabled !== disabled)) {
        await api(`/connections/${encodeURIComponent(a.id)}`, { method: "PATCH", body: { disabled } });
      }
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
      reloadConnections();
    }
  }

  const ready = providers.status === "ready" && connections.status === "ready";
  const needle = query.trim().toLowerCase();
  const shown = ready
    ? providers.data
        .map((p) => ({ provider: p, accounts: connections.data.filter((c) => c.provider === p.id) }))
        .filter(({ provider, accounts }) => matches(filter, accounts) && (needle === "" || provider.name.toLowerCase().includes(needle) || provider.id.includes(needle)))
    : [];

  return (
    <Stack gap={4}>
      <div className="page-actions">
        <Select
          aria-label={t("providers.filter")}
          icon="filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          options={FILTERS.map((f) => ({ value: f, label: t(`providers.filter.${f}`) }))}
        />
      </div>
      {error && <Banner tone="danger" title={error} />}
      {(providers.status === "loading" || connections.status === "loading") && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
      {(providers.status === "error" || connections.status === "error") && (
        <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />
      )}
      {ready && shown.length === 0 && <EmptyState icon="search" title={t("providers.noMatch")} />}
      {SECTIONS.map(({ kind, title, hint }) => {
        const cards = shown.filter(({ provider }) => sectionOf(provider) === kind);
        const custom = kind === "custom";
        // The custom section stays on an unfiltered page with none yet, so its add buttons can be found.
        const noCustomYet = custom && ready && needle === "" && filter === "all" && !providers.data.some((p) => p.custom);
        if (cards.length === 0 && !noCustomYet) return null;
        const targets = cards.flatMap(({ accounts }) => accounts.filter((a) => !a.disabled));
        const running = testing?.kind === kind ? testing : null;
        const result = summary?.kind === kind ? summary : null;
        return (
          <section key={kind} className="providers-section">
            <div className="providers-section-head">
              <h2 className="providers-section-title">{t(title)}</h2>
              <span className="providers-section-count">{cards.length}</span>
              <div className="providers-section-actions">
                {targets.length > 0 && (
                  <Button size="sm" icon="check" aria-label={t("providers.testAllLabel", { section: t(title) })} disabled={testing !== null} onClick={() => void testAll(kind, targets)}>
                    {t("providers.testAll")}
                  </Button>
                )}
                {custom && (
                  <>
                    <Button size="sm" icon="plus" onClick={() => setAdding("openai")}>
                      {t("providers.custom.addOpenai")}
                    </Button>
                    <Button size="sm" icon="plus" onClick={() => setAdding("anthropic")}>
                      {t("providers.custom.addAnthropic")}
                    </Button>
                  </>
                )}
              </div>
            </div>
            {hint && <p className="providers-section-sub">{t(hint)}</p>}
            {running && <Banner tone="info" title={t("providers.testAllProgress", { done: String(running.done), n: String(running.n) })} />}
            {result && (
              <Banner
                tone="warn"
                title={t("providers.testAllSome", { ok: String(result.ok), failed: String(result.failed) })}
                action={<IconButton icon="close" label={t("common.close")} onClick={() => setSummary(null)} />}
              >
                {t("providers.testAllSomeHint")}
              </Banner>
            )}
            {cards.length === 0 ? (
              <EmptyState icon="plug" title={t("providers.custom.empty")} hint={t("providers.custom.emptyHint")} />
            ) : (
            <Grid minItemWidth="15rem" gap={3}>
              {cards.map(({ provider, accounts }) => (
                <ResourceCard
                  key={provider.id}
                  href={`#/providers/${provider.id}`}
                  leading={<Emblem name={provider.name} text={provider.mark} color={provider.color} src={providerLogo(provider.id)} />}
                  title={provider.name}
                  status={<ProviderStatus provider={provider} accounts={accounts} />}
                  dimmed={accounts.length > 0 && accounts.every((a) => a.disabled)}
                  revealTrailing="hover"
                  trailing={
                    accounts.length > 0 ? (
                      <Switch
                        aria-label={t("providers.useProvider", { name: provider.name })}
                        checked={accounts.some((a) => !a.disabled)}
                        disabled={busy}
                        onChange={() => void toggle(accounts)}
                      />
                    ) : undefined
                  }
                />
              ))}
            </Grid>
            )}
          </section>
        );
      })}
      {adding && (
        <CustomProviderDialog
          provider={null}
          format={adding}
          onCancel={() => setAdding(null)}
          onSaved={(notice) => {
            notify(notice);
            setAdding(null);
            reloadProviders();
          }}
        />
      )}
    </Stack>
  );
}

type Pending =
  | { kind: "edit"; account: Connection | null }
  | { kind: "delete"; account: Connection }
  | { kind: "oauth"; url: string }
  | { kind: "device"; login: DeviceLogin }
  | { kind: "customEdit" }
  | { kind: "customDelete" }
  | null;

/** One provider's accounts, in the order the gateway tries them: add, rename, replace a key, switch off, reorder, delete. */
export function ProviderDetail({ id }: { id: string }) {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [providers, reloadProviders] = useLoad<Provider[]>("/providers");
  const [connections, reload] = useLoad<Connection[]>("/connections");
  // No pools (or no proxy-pool route): the pool choices are not shown.
  const [poolsLoad] = useLoad<Pool[]>("/proxy-pools");
  const pools = poolsLoad.status === "ready" && Array.isArray(poolsLoad.data) ? poolsLoad.data : [];
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The order just chosen, shown until the gateway's answer replaces it. */
  const [order, setOrder] = useState<string[] | null>(null);

  const loaded = connections.status === "ready" ? connections.data : null;
  useEffect(() => setOrder(null), [loaded]);

  const provider = providers.status === "ready" ? (providers.data.find((p) => p.id === id) ?? null) : null;
  const mine = (loaded ?? []).filter((c) => c.provider === id);
  const accounts = order ? [...mine].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : mine;
  const name = provider?.name ?? id;
  // The top bar reads "Providers › logo + name" on a provider's detail page.
  useShellTitle(
    <ShellTitle
      parent={{ label: t("providers.title"), href: "#/providers" }}
      title={name}
      media={<Emblem name={name} text={provider?.mark} color={provider?.color} src={providerLogo(id)} size="sm" />}
    />,
    `${id}|${name}|${provider?.mark ?? ""}|${provider?.color ?? ""}|${lang}`,
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (a: Connection) =>
    run(async () => {
      await api(`/connections/${encodeURIComponent(a.id)}`, { method: "PATCH", body: { disabled: !a.disabled } });
      reload();
    });

  const setPool = (a: Connection, pool: string | null) =>
    run(async () => {
      await api(`/connections/${encodeURIComponent(a.id)}`, { method: "PATCH", body: { proxy_pool: pool } });
      reload();
    });

  const reorder = (from: number, to: number) => {
    const ids = moveItem(accounts, from, to).map((a) => a.id);
    setOrder(ids);
    void run(async () => {
      try {
        await api(`/providers/${encodeURIComponent(id)}/order`, { method: "PUT", body: { ids } });
      } finally {
        reload();
      }
    });
  };

  const isOAuth = provider?.auth[0] === "oauth";

  /**
   * A subscription provider has no key to type. A browser sign-in opens its page in a new tab and a dialog waits for the result;
   * a device sign-in shows a code to enter at the provider's page while the dialog asks the gateway whether it is done.
   */
  const startSignIn = () =>
    run(async () => {
      const r = await api<({ flow?: "pkce"; authorize_url: string }) | ({ flow: "device" } & DeviceLogin)>(`/oauth/${encodeURIComponent(id)}/start`, {
        method: "POST",
      });
      if (r.flow === "device") {
        window.open(r.verification_uri_complete ?? r.verification_uri, "_blank", "noopener");
        setPending({ kind: "device", login: r });
        return;
      }
      window.open(r.authorize_url, "_blank", "noopener");
      setPending({ kind: "oauth", url: r.authorize_url });
    });

  const setRoundRobin = (on: boolean) =>
    run(async () => {
      await api(`/providers/${encodeURIComponent(id)}/strategy`, { method: "PUT", body: { strategy: on ? "round-robin" : "fill-first" } });
      reloadProviders();
    });

  /** Asks the gateway to check the key at the provider, and says what came back. */
  const test = (a: Connection) =>
    run(async () => {
      const r = await api<{ ok: true } | { ok: false; status: number; message: string }>(`/connections/${encodeURIComponent(a.id)}/test`, { method: "POST" });
      notify(r.ok ? t("providers.testOk", { name: a.name }) : t("providers.testFailed", { name: a.name, error: `${r.status} ${r.message}` }));
      reload();
    });

  const remove = (a: Connection) =>
    run(async () => {
      await api(`/connections/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      notify(t("providers.deletedNotice", { name: a.name }));
      setPending(null);
      reload();
    });

  /** Why the custom provider was not deleted, shown in its dialog. */
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Deletes the owner's provider and goes back to the list; the gateway refuses while it has connections. */
  async function removeCustom() {
    setBusy(true);
    setDeleteError(null);
    try {
      await api(`/custom-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      notify(t("providers.deletedNotice", { name }));
      setPending(null);
      window.location.hash = "#/providers";
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setDeleteError(e instanceof ApiError && e.code === "in_use" ? t("providers.custom.inUse", { n: String(mine.length) }) : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const status = (a: Connection) => {
    if (a.disabled) return <StatusDot tone="neutral" label={t("providers.status.off")} />;
    if (isCooling(a)) {
      const time = new Date(a.cooldown_until * 1000).toLocaleTimeString(lang === "vi" ? "vi-VN" : "en-US", { hour: "2-digit", minute: "2-digit" });
      return <StatusDot tone="warn" label={t("providers.status.cooling", { time })} />;
    }
    return <StatusDot tone="ok" label={t("providers.status.ok")} />;
  };

  const meta = (a: Connection) => {
    const lines = [a.auth_type === "oauth" ? t("providers.status.signedIn") : a.hint ? t("providers.keyEnds", { hint: a.hint }) : null, a.last_error ? t("providers.lastError", { error: a.last_error }) : null].filter(
      (x): x is string => x !== null,
    );
    if (lines.length === 0) return undefined;
    return (
      <>
        {lines.map((line) => (
          <span key={line} className="account-meta-line">
            {line}
          </span>
        ))}
      </>
    );
  };

  return (
    <Stack gap={4}>
      <a className="back-link" href="#/providers">
        <Icon name="arrow-left" size={16} />
        {t("providers.back")}
      </a>
      <div className="provider-head">
        {loaded && <span className="provider-count">{t("providers.connections", { n: String(mine.length) })}</span>}
        {provider?.key_url && (
          <a className="back-link" href={provider.key_url} target="_blank" rel="noreferrer noopener">
            <Icon name="external" size={16} />
            {isOAuth ? t("providers.signUp") : t("providers.getKey")}
          </a>
        )}
      </div>
      {error && <Banner tone="danger" title={error} />}
      {(providers.status === "loading" || connections.status === "loading") && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
      {(providers.status === "error" || connections.status === "error") && (
        <Banner
          tone="danger"
          title={t("error.load")}
          action={
            <Button
              onClick={() => {
                reloadProviders();
                reload();
              }}
            >
              {t("common.retry")}
            </Button>
          }
        />
      )}
      {providers.status === "ready" && !provider && <Banner tone="danger" title={t("providers.unknown")} />}
      {provider && loaded && (
        <>
          {isOAuth && <Banner tone="warn" title={t("providers.riskNotice")} />}
          {provider.missing_env?.length ? <Banner tone="danger" title={t("providers.oauth.unavailable", { vars: provider.missing_env.join(", ") })} /> : null}
          {provider.env_key && <Banner tone="info" title={t("providers.envKeyNote")} />}
          {provider.custom && (
            <Card
              title={t("providers.custom.endpointTitle")}
              subtitle={t(provider.format === "anthropic" ? "providers.custom.format.anthropic" : "providers.custom.format.openai")}
              actions={
                <>
                  <Button disabled={busy} onClick={() => setPending({ kind: "customEdit" })}>
                    {t("providers.custom.edit")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setDeleteError(null);
                      setPending({ kind: "customDelete" });
                    }}
                  >
                    {t("providers.custom.delete")}
                  </Button>
                </>
              }
            >
              <code className="provider-endpoint">{provider.base_url}</code>
            </Card>
          )}
          <Card
            title={t("providers.accountsTitle")}
            subtitle={accounts.length > 1 ? t("providers.accountsHint") : undefined}
            actions={
              <>
                <Switch label={t("providers.roundRobin")} checked={provider.strategy === "round-robin"} disabled={busy} onChange={(e) => void setRoundRobin(e.target.checked)} />
                <Button variant="primary" icon="plus" disabled={busy || !!provider.missing_env?.length} onClick={() => (isOAuth ? void startSignIn() : setPending({ kind: "edit", account: null }))}>
                  {t("providers.add")}
                </Button>
              </>
            }
            flush
          >
            {accounts.length === 0 ? (
              <EmptyState icon="plug" title={t("providers.empty")} />
            ) : (
              <SortableList
                items={accounts}
                getKey={(a) => a.id}
                getLabel={(a) => a.name}
                label={t("providers.accountsTitle")}
                labels={{ handle: (name) => t("providers.move", { name }) }}
                disabled={busy}
                onReorder={reorder}
                renderItem={(a, _index, handle) => (
                  <ListRow
                    className="account-row"
                    leading={handle}
                    title={a.name}
                    meta={meta(a)}
                    trailing={
                      <>
                        {isOAuth && pools.length > 0 && (
                          <Select
                            aria-label={t("providers.poolFor", { name: a.name })}
                            value={a.proxy_pool ?? ""}
                            disabled={busy}
                            options={[{ value: "", label: t("providers.poolNone") }, ...pools.map((p) => ({ value: p.id, label: p.name }))]}
                            onChange={(e) => void setPool(a, e.target.value || null)}
                          />
                        )}
                        {status(a)}
                        <Switch aria-label={t("providers.enabled", { name: a.name })} checked={!a.disabled} disabled={busy} onChange={() => void toggle(a)} />
                        <MenuButton
                          variant="icon"
                          align="end"
                          label={`${t("systems.col.actions")}: ${a.name}`}
                          disabled={busy}
                          items={[
                            { label: t("providers.test"), onSelect: () => void test(a) },
                            { label: t("providers.edit"), onSelect: () => setPending({ kind: "edit", account: a }) },
                            { type: "separator" },
                            { label: t("providers.delete"), danger: true, onSelect: () => setPending({ kind: "delete", account: a }) },
                          ]}
                        />
                      </>
                    }
                  />
                )}
              />
            )}
          </Card>
          {isOAuth && <HeadersCard provider={id} />}
          <ProviderModelsCard provider={id} />
        </>
      )}
      {pending?.kind === "oauth" && provider && (
        <SignInDialog
          provider={provider}
          url={pending.url}
          onCancel={() => setPending(null)}
          onDone={(name) => {
            if (name) notify(t("providers.signedIn", { name }));
            setPending(null);
            reload();
          }}
        />
      )}
      {pending?.kind === "device" && provider && (
        <DeviceSignInDialog
          provider={provider}
          login={pending.login}
          onCancel={() => setPending(null)}
          onDone={(name) => {
            notify(t("providers.signedIn", { name }));
            setPending(null);
            reload();
          }}
        />
      )}
      {pending?.kind === "edit" && (
        <AccountDialog
          provider={id}
          account={pending.account}
          settings={provider?.settings ?? []}
          pools={pools}
          onCancel={() => setPending(null)}
          onChanged={reload}
          onSaved={(notice) => {
            notify(notice);
            setPending(null);
            reload();
          }}
        />
      )}
      {pending?.kind === "delete" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("providers.deleteTitle", { name: pending.account.name })}
          labels={labels.dialog}
          confirmLabel={t("providers.delete")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void remove(pending.account)}
        >
          {t("providers.deleteBody")}
        </Dialog>
      )}
      {pending?.kind === "customEdit" && provider && (
        <CustomProviderDialog
          provider={provider}
          format={provider.format === "anthropic" ? "anthropic" : "openai"}
          onCancel={() => setPending(null)}
          onSaved={(notice) => {
            notify(notice);
            setPending(null);
            reloadProviders();
          }}
        />
      )}
      {pending?.kind === "customDelete" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("providers.deleteTitle", { name })}
          labels={labels.dialog}
          confirmLabel={t("providers.delete")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void removeCustom()}
        >
          {deleteError && <Banner tone="danger" title={deleteError} />}
          {t("providers.custom.deleteBody", { id })}
        </Dialog>
      )}
    </Stack>
  );
}

/** Adds the owner's own provider (preset to the button's format), or edits its name, format and base URL. */
function CustomProviderDialog({
  provider,
  format,
  onCancel,
  onSaved,
}: {
  provider: Provider | null;
  format: CustomFormat;
  onCancel: () => void;
  onSaved: (notice: string) => void;
}) {
  const [lang] = useLang();
  const creating = provider === null;
  const [form, setForm] = useState<CustomProviderForm>({ id: provider?.id ?? "", name: provider?.name ?? "", format, base_url: provider?.base_url ?? "" });
  const [tried, setTried] = useState(false);
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validateCustomProvider(form, creating);
  const shown = (key: keyof CustomErrors) => (tried && errors[key] ? t(errors[key]) : undefined);
  const set = (key: keyof CustomProviderForm, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    const body = { name: form.name.trim(), format: form.format, base_url: form.base_url.trim() };
    setBusy(true);
    setError(null);
    try {
      if (provider) await api(`/custom-providers/${encodeURIComponent(provider.id)}`, { method: "PATCH", body });
      else await api("/custom-providers", { body: { id: form.id.trim(), ...body } });
      onSaved(t(creating ? "providers.custom.createdNotice" : "providers.savedNotice", { name: body.name }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.code === "taken") setTaken(true);
      else setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={provider ? t("providers.editTitle", { name: provider.name }) : t("providers.custom.addTitle")}
      submitLabel={t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Stack gap={2}>
        <label className="settings-label" htmlFor="custom-provider-format">
          {t("providers.custom.format")}
        </label>
        <Select
          id="custom-provider-format"
          value={form.format}
          disabled={busy}
          options={(["openai", "anthropic"] as const).map((f) => ({ value: f, label: t(`providers.custom.format.${f}`) }))}
          onChange={(e) => set("format", e.target.value)}
        />
      </Stack>
      {creating && (
        <Field
          label={t("providers.custom.id")}
          hint={t("providers.custom.idHint")}
          value={form.id}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            set("id", e.target.value);
            setTaken(false);
          }}
          error={shown("id") ?? (taken ? t("providers.custom.idTaken") : undefined)}
        />
      )}
      <Field label={t("providers.name")} hint={t("providers.custom.nameHint")} value={form.name} autoComplete="off" onChange={(e) => set("name", e.target.value)} error={shown("name")} />
      <Field
        label={t("providers.custom.baseUrl")}
        hint={t(form.format === "anthropic" ? "providers.custom.baseUrlHint.anthropic" : "providers.custom.baseUrlHint.openai")}
        inputMode="url"
        value={form.base_url}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => set("base_url", e.target.value)}
        error={shown("base_url")}
      />
    </FormDialog>
  );
}

/** One line of the Bulk add box: `key`, or `name|key` (split at the first bar). `name` is null when the line has none. */
export interface BulkLine {
  line: number;
  name: string | null;
  key: string;
  /** The line as typed, put back in the box when it fails. */
  raw: string;
}
export interface BulkProblem {
  line: number;
  kind: "emptyKey" | "longName";
}

/** Reads the Bulk add box: one key per line, blank lines skipped, line numbers as the user sees them. */
export function parseBulkKeys(text: string): { lines: BulkLine[]; problems: BulkProblem[] } {
  const lines: BulkLine[] = [];
  const problems: BulkProblem[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const row = raw.trim();
    if (row === "") return;
    const bar = row.indexOf("|");
    const name = bar < 0 ? "" : row.slice(0, bar).trim();
    const key = (bar < 0 ? row : row.slice(bar + 1)).trim();
    const line = i + 1;
    if (key === "") problems.push({ line, kind: "emptyKey" });
    else if (name.length > 100) problems.push({ line, kind: "longName" });
    else lines.push({ line, name: name === "" ? null : name, key, raw: row });
  });
  return { lines, problems };
}

/** Takes a key out of a provider's message, in case the provider quoted it back. */
const redact = (text: string, key: string): string => (key ? text.split(key).join("***") : text);

const PRIORITY = /^\d{1,4}$/;
const priorityOk = (raw: string) => raw.trim() === "" || (PRIORITY.test(raw.trim()) && Number(raw) >= 1 && Number(raw) <= 1000);

type Mode = "single" | "bulk";
type CheckResult = { ok: boolean; text: string };
type BulkResult = { line: number; ok: boolean; text: string };

/**
 * Adds an account (one key, or many at once), or renames one and replaces its key. A key is sent to the gateway
 * and never read back; Check asks the provider with a key that is not saved yet.
 */
/** The label of a connection setting (worker/wire.ts); an unknown one shows its name. */
const SETTING_LABELS: Record<string, StringKey> = {
  region: "providers.setting.region",
  account_id: "providers.setting.account_id",
  endpoint: "providers.setting.endpoint",
  deployment: "providers.setting.deployment",
  api_version: "providers.setting.api_version",
  access_key_id: "providers.setting.access_key_id",
  session_token: "providers.setting.session_token",
  location: "providers.setting.location",
};

function AccountDialog({
  provider,
  account,
  settings,
  pools,
  onCancel,
  onChanged,
  onSaved,
}: {
  provider: string;
  account: Connection | null;
  /** The provider's connection settings; their saved values are never sent back, so editing starts empty. */
  settings: ProviderSetting[];
  pools: Pool[];
  onCancel: () => void;
  /** Some keys of a bulk add were saved and the dialog stays open for the rest. */
  onChanged: () => void;
  onSaved: (notice: string) => void;
}) {
  const [lang] = useLang();
  const [mode, setMode] = useState<Mode>("single");
  const [name, setName] = useState(account?.name ?? "");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("");
  const [pool, setPool] = useState(account?.proxy_pool ?? "");
  const [bulk, setBulk] = useState("");
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const isKey = account?.auth_type !== "oauth";
  // Only filled settings are sent: on an existing account an empty one keeps the saved value.
  const settingsBody = (): { settings?: Record<string, string> } => {
    const filled = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ""));
    return Object.keys(filled).length > 0 ? { settings: filled } : {};
  };
  const missingSetting = (s: ProviderSetting) => !account && s.required && (values[s.name] ?? "").trim() === "";
  const settingsOk = !isKey || !settings.some(missingSetting);
  const nameOk = name.trim() !== "" && name.length <= 100;
  // A new account needs a key; an existing one keeps its key when the field is left empty.
  const keyOk = account ? true : apiKey.trim() !== "";
  const parsed = parseBulkKeys(bulk);
  const poolOptions = [{ value: "", label: t("providers.poolNone") }, ...pools.map((p) => ({ value: p.id, label: p.name }))];
  const poolBody = (p: string) => (p ? { proxy_pool: p } : {});

  const failure = (e: unknown, key: string) =>
    e instanceof ApiError && e.code === "not_configured"
      ? t("providers.notConfigured")
      : e instanceof ApiError && e.detail
        ? redact(e.detail, key)
        : e instanceof ApiError && e.code === "invalid_input"
          ? t("providers.bulkRefused")
          : t("error.generic");

  /** The key is checked by the gateway at the provider; only the outcome and the time it took are shown. */
  async function runCheck() {
    const key = apiKey.trim();
    if (!key) return;
    setChecking(true);
    setCheck(null);
    const started = performance.now();
    try {
      const r = await api<{ ok: true } | { ok: false; status: number; message: string }>("/connections/check", { body: { provider, api_key: key, ...settingsBody() } });
      const ms = String(Math.round(performance.now() - started));
      setCheck(r.ok ? { ok: true, text: t("providers.checkOk", { ms }) } : { ok: false, text: t("providers.checkFailed", { status: String(r.status), message: redact(r.message, key) }) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setCheck({ ok: false, text: failure(e, key) });
    } finally {
      setChecking(false);
    }
  }

  async function submitOne() {
    setTried(true);
    if (!nameOk || !keyOk || !priorityOk(priority) || !settingsOk) return;
    setBusy(true);
    setError(null);
    const key = apiKey.trim();
    try {
      if (account) {
        const poolChanged = isKey && pool !== (account.proxy_pool ?? "");
        await api(`/connections/${encodeURIComponent(account.id)}`, {
          method: "PATCH",
          body: { name: name.trim(), ...(key ? { api_key: key } : {}), ...(poolChanged ? { proxy_pool: pool || null } : {}), ...(isKey ? settingsBody() : {}) },
        });
      } else {
        await api("/connections", {
          body: { provider, name: name.trim(), api_key: key, ...(priority.trim() ? { priority: Number(priority) } : {}), ...poolBody(pool), ...settingsBody() },
        });
      }
      onSaved(t("providers.savedNotice", { name: name.trim() }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(failure(e, key));
    } finally {
      setBusy(false);
    }
  }

  /** One POST per line, in order, so the accounts keep the order of the box. Failed lines stay in the box. */
  async function submitBulk() {
    setTried(true);
    if (parsed.lines.length === 0 || parsed.problems.length > 0 || !settingsOk) return;
    setBusy(true);
    setError(null);
    const results: BulkResult[] = [];
    const failed: string[] = [];
    try {
      for (const [i, l] of parsed.lines.entries()) {
        const lineName = l.name ?? t("providers.bulkKeyName", { n: String(i + 1) });
        try {
          await api("/connections", { body: { provider, name: lineName, api_key: l.key, ...poolBody(pool), ...settingsBody() } });
          results.push({ line: l.line, ok: true, text: t("providers.bulkLineOk", { line: String(l.line), name: lineName }) });
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) return;
          results.push({ line: l.line, ok: false, text: t("providers.bulkLineFailed", { line: String(l.line), error: failure(e, l.key) }) });
          failed.push(l.raw);
        }
      }
    } finally {
      setBusy(false);
    }
    const saved = results.filter((r) => r.ok).length;
    if (failed.length === 0) {
      onSaved(t("providers.bulkDone", { n: String(saved) }));
      return;
    }
    if (saved > 0) onChanged();
    setTried(false);
    setBulk(failed.join("\n"));
    setBulkResults(results);
    setError(t("providers.bulkSome", { ok: String(saved), n: String(results.length) }));
  }

  const bulkError = () => {
    if (!tried) return undefined;
    if (parsed.problems.length > 0) {
      const p = parsed.problems[0];
      return t(p.kind === "emptyKey" ? "providers.bulkEmptyKey" : "providers.bulkLongName", { line: String(p.line) });
    }
    return parsed.lines.length === 0 ? t("providers.bulkRequired") : undefined;
  };

  /** The proxy pool choice; only when the gateway has a pool. Laid out as the console's other labelled selects. */
  const poolField = (label: StringKey, hint?: StringKey) =>
    pools.length > 0 && isKey ? (
      <Stack gap={2}>
        <label className="settings-label" htmlFor="account-pool">
          {t(label)}
        </label>
        <Select
          id="account-pool"
          aria-describedby={hint ? "account-pool-hint" : undefined}
          value={pool}
          disabled={busy}
          options={poolOptions}
          onChange={(e) => setPool(e.target.value)}
        />
        {hint && (
          <span className="muted" id="account-pool-hint">
            {t(hint)}
          </span>
        )}
      </Stack>
    ) : null;

  /** The provider's connection settings (Azure's endpoint, Bedrock's access key id, ...), after the key. */
  const settingFields =
    isKey && settings.length > 0
      ? settings.map((s) => {
          const label = SETTING_LABELS[s.name] ? t(SETTING_LABELS[s.name]) : s.name;
          const id = `account-setting-${s.name}`;
          const fallback = account ? t("providers.settingKeep") : s.default ? t("providers.settingDefault", { value: s.default }) : undefined;
          const set = (v: string) => {
            setValues((x) => ({ ...x, [s.name]: v }));
            setCheck(null);
          };
          if (s.options) {
            return (
              <Stack gap={2} key={s.name}>
                <label className="settings-label" htmlFor={id}>
                  {label}
                </label>
                <Select
                  id={id}
                  value={values[s.name] ?? ""}
                  disabled={busy}
                  options={[{ value: "", label: fallback ?? "" }, ...s.options.map((o) => ({ value: o, label: o }))]}
                  onChange={(e) => set(e.target.value)}
                />
              </Stack>
            );
          }
          return (
            <Field
              key={s.name}
              id={id}
              label={label}
              hint={fallback}
              type={s.secret ? "password" : "text"}
              value={values[s.name] ?? ""}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set(e.target.value)}
              error={tried && missingSetting(s) ? t("providers.settingRequired") : undefined}
            />
          );
        })
      : null;

  const single = (
    <>
      <Field
        label={t("providers.name")}
        hint={t("providers.nameHint")}
        value={name}
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
        error={tried && !nameOk ? t("providers.nameRequired") : undefined}
      />
      {isKey && (
        <>
          <Field
            label={t("providers.apiKey")}
            hint={account ? t("providers.apiKeyKeepHint") : t("providers.apiKeyHint")}
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setApiKey(e.target.value);
              setCheck(null);
            }}
            error={tried && !keyOk ? t("providers.apiKeyRequired") : undefined}
          />
          {settingFields}
          <div className="account-check" aria-live="polite">
            <Button size="sm" icon="check" disabled={checking || busy || apiKey.trim() === ""} onClick={() => void runCheck()}>
              {checking ? t("providers.checking") : t("providers.check")}
            </Button>
            {check && <StatusDot tone={check.ok ? "ok" : "danger"} label={check.text} />}
          </div>
        </>
      )}
      {!account && (
        <Field
          label={t("providers.priority")}
          hint={t("providers.priorityHint")}
          inputMode="numeric"
          value={priority}
          autoComplete="off"
          onChange={(e) => setPriority(e.target.value)}
          error={tried && !priorityOk(priority) ? t("providers.priorityBad") : undefined}
        />
      )}
      {poolField("providers.pool", "providers.poolHint")}
    </>
  );

  const bulkPanel = (
    <>
      <Textarea
        label={t("providers.bulkKeys")}
        hint={t("providers.bulkHint")}
        mono
        rows={6}
        value={bulk}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setBulk(e.target.value)}
        error={bulkError()}
      />
      {settingFields}
      {poolField("providers.bulkPool", "providers.poolHint")}
      {bulkResults.length > 0 && (
        <ul className="bulk-results" aria-label={t("providers.bulkResults")}>
          {bulkResults.map((r) => (
            <li key={r.line}>
              <StatusDot tone={r.ok ? "ok" : "danger"} label={r.text} />
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const isBulk = !account && mode === "bulk";
  return (
    <FormDialog
      title={account ? t("providers.editTitle", { name: account.name }) : t("providers.add")}
      submitLabel={isBulk && parsed.lines.length > 0 ? t("providers.bulkSave", { n: String(parsed.lines.length) }) : t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void (isBulk ? submitBulk() : submitOne())}
    >
      {account ? (
        single
      ) : (
        <>
          <Tabs
            variant="pill"
            label={t("providers.addTabs")}
            idPrefix="account"
            value={mode}
            onChange={(v) => {
              setMode(v as Mode);
              setTried(false);
              setError(null);
            }}
            items={[
              { id: "single", label: t("providers.tab.single") },
              { id: "bulk", label: t("providers.tab.bulk") },
            ]}
          />
          <div className="account-panel" role="tabpanel" id={`account-panel-${mode}`} aria-labelledby={`account-tab-${mode}`}>
            {mode === "single" ? single : bulkPanel}
          </div>
        </>
      )}
    </FormDialog>
  );
}

/** Codex's custom headers: name and value pairs added to every request it sends (GET/PUT /admin/providers/:id/headers). */
function HeadersCard({ provider }: { provider: string }) {
  const notify = useNotify();
  const path = `/providers/${encodeURIComponent(provider)}/headers`;
  const [loaded, reload] = useLoad<{ headers: Record<string, string> }>(path);
  const [rows, setRows] = useState<{ name: string; value: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded.status === "ready") setRows(Object.entries(loaded.data.headers).map(([name, value]) => ({ name, value })));
  }, [loaded]);

  // Only some providers take custom headers; the others answer 404 and have no card.
  if (loaded.status === "error" && loaded.code === "not_found") return null;

  const edit = (i: number, patch: Partial<{ name: string; value: string }>) => setRows((r) => (r ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const headers = Object.fromEntries((rows ?? []).filter((r) => r.name.trim() !== "").map((r) => [r.name.trim(), r.value]));
      const r = await api<{ headers: Record<string, string> }>(path, { method: "PUT", body: { headers } });
      setRows(Object.entries(r.headers).map(([name, value]) => ({ name, value })));
      notify(t("providers.headersSaved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.detail ? e.detail : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={t("providers.headers")}
      subtitle={t("providers.headersHint")}
      actions={
        rows && (
          <>
            <Button icon="plus" disabled={busy} onClick={() => setRows((r) => [...(r ?? []), { name: "", value: "" }])}>
              {t("providers.headerAdd")}
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? t("common.saving") : t("providers.headerSave")}
            </Button>
          </>
        )
      }
    >
      {loaded.status === "loading" && <Skeleton lines={2} announce labels={{ loading: t("loading") }} />}
      {loaded.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {rows && (
        <Stack gap={3}>
          {error && <Banner tone="danger" title={error} />}
          {rows.length === 0 && <p className="muted">{t("providers.headersEmpty")}</p>}
          {rows.map((r, i) => (
            <div key={i} className="header-row">
              <Field
                label={i === 0 ? t("providers.headerName") : `${t("providers.headerName")} ${i + 1}`}
                hideLabel={i > 0}
                value={r.name}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => edit(i, { name: e.target.value })}
              />
              <Field
                label={i === 0 ? t("providers.headerValue") : `${t("providers.headerValue")} ${i + 1}`}
                hideLabel={i > 0}
                value={r.value}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => edit(i, { value: e.target.value })}
              />
              <IconButton icon="trash" label={t("providers.headerRemove", { n: String(i + 1) })} disabled={busy} onClick={() => setRows((x) => (x ?? []).filter((_, j) => j !== i))} />
            </div>
          ))}
        </Stack>
      )}
    </Card>
  );
}

/**
 * Waits for a subscription sign-in that runs in another tab. When the provider's redirect reaches the gateway
 * (a local run with the callback port mapped) the user only confirms; otherwise the user pastes the address of
 * the page the browser ended on.
 */
function SignInDialog({ provider, url, onCancel, onDone }: { provider: Provider; url: string; onCancel: () => void; onDone: (name: string | null) => void }) {
  const [lang] = useLang();
  const [callback, setCallback] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setTried(true);
    if (callback.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const c = await api<Connection>(`/oauth/${encodeURIComponent(provider.id)}/finish`, { body: { callback_url: callback.trim() } });
      onDone(c.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.detail ? t("providers.oauth.failed", { message: e.detail }) : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={t("providers.oauth.title", { name: provider.name })}
      description={t("providers.oauth.description")}
      submitLabel={t("providers.oauth.finish")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void finish()}
    >
      <Field
        label={t("providers.oauth.callback")}
        hint={t("providers.oauth.callbackHint", { origin: redirectOrigin(url) })}
        value={callback}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setCallback(e.target.value)}
        error={tried && callback.trim() === "" ? t("providers.oauth.callbackRequired") : undefined}
      />
      <Stack direction="row" gap={2}>
        <Button onClick={() => onDone(null)}>{t("providers.oauth.done")}</Button>
        <Button onClick={() => window.open(url, "_blank", "noopener")}>{t("providers.oauth.reopen")}</Button>
      </Stack>
    </FormDialog>
  );
}

/** Where the provider sends the browser back to (the start of the address the user pastes), read from the sign-in page's address. */
export function redirectOrigin(authorizeUrl: string): string {
  try {
    const back = new URL(authorizeUrl).searchParams.get("redirect_uri");
    return back ? new URL(back).origin : "http://localhost";
  } catch {
    return "http://localhost";
  }
}

/** What the gateway answers when a device sign-in starts: a code to type at the provider's page, and how often to ask whether it is done. */
type DeviceLogin = {
  id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
};

/**
 * Shows the code of a device sign-in (GitHub Copilot) and asks the gateway every few seconds whether the user has
 * entered it. It closes by itself when the account is added.
 */
function DeviceSignInDialog({ provider, login, onCancel, onDone }: { provider: Provider; login: DeviceLogin; onCancel: () => void; onDone: (name: string) => void }) {
  const [lang] = useLang();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  /** Bumped by "Check again" after an error, which starts the polling over. */
  const [round, setRound] = useState(0);
  const page = login.verification_uri_complete ?? login.verification_uri;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + login.expires_in * 1000;
    const next = (seconds: number) => {
      timer = setTimeout(() => void poll(), Math.max(1, seconds) * 1000);
    };
    async function poll() {
      if (stopped) return;
      if (Date.now() > deadline) {
        setExpired(true);
        return;
      }
      try {
        const r = await api<Connection | { status: "pending"; interval: number }>(`/oauth/${encodeURIComponent(provider.id)}/poll`, { body: { id: login.id } });
        if (stopped) return;
        if ("status" in r && r.status === "pending") next(r.interval);
        else onDone((r as Connection).name);
      } catch (e) {
        if (stopped || (e instanceof ApiError && e.status === 401)) return;
        setError(e instanceof ApiError && e.detail ? t("providers.oauth.failed", { message: e.detail }) : t("error.generic"));
      }
    }
    next(login.interval);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // onDone changes on every render of the page; the polling only restarts for a new sign-in or "Check again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login.id, round]);

  const copy = () => {
    void navigator.clipboard?.writeText(login.user_code).then(
      () => notify(t("providers.device.copied")),
      () => undefined,
    );
  };

  return (
    <Dialog
      modal
      title={t("providers.oauth.title", { name: provider.name })}
      description={t("providers.device.description")}
      labels={ui(lang).dialog}
      confirmLabel={error ? t("providers.device.retry") : t("providers.oauth.reopen")}
      onConfirm={() => {
        if (error) {
          setError(null);
          setRound((n) => n + 1);
        } else window.open(page, "_blank", "noopener");
      }}
      confirmDisabled={expired || undefined}
      onCancel={onCancel}
      body="plain"
    >
      <Stack gap={3}>
        <PairingCode value={login.user_code} groupSize={4} size="lg" label={t("providers.device.code")} copyLabel={t("providers.device.copy")} onCopy={copy} />
        <a href={page} target="_blank" rel="noopener noreferrer">
          {login.verification_uri}
        </a>
        {expired ? (
          <Banner tone="warn"title={t("providers.device.expired")} />
        ) : error ? (
          <Banner tone="danger" title={error} />
        ) : (
          <p role="status">{t("providers.device.waiting")}</p>
        )}
      </Stack>
    </Dialog>
  );
}

