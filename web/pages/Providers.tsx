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
  ListRow,
  Emblem,
  MenuButton,
  PageHeader,
  ResourceCard,
  SearchInput,
  Select,
  Skeleton,
  SortableList,
  Stack,
  StatusDot,
  Switch,
  moveItem,
} from "@xdev-asia/ui";
import { ApiError, api, useLoad, type Connection, type Provider } from "../api";
import { t, useLang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { providerLogo } from "../provider-logos";
import { ui } from "../ui-labels";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const isCooling = (c: Connection) => !c.disabled && c.cooldown_until > nowSeconds();

type Filter = "all" | "connected" | "error" | "none";
const FILTERS: Filter[] = ["all", "connected", "error", "none"];

/** How the providers are grouped on the page, in this order; a group with no provider is not shown. */
const SECTIONS: { kind: string; title: StringKey }[] = [
  { kind: "oauth", title: "providers.section.oauth" },
  { kind: "api_key", title: "providers.section.api_key" },
];

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
 * Providers, laid out as 9router's page: a search field and a status filter, then one section per kind of
 * provider, each a grid of cards. A card opens the provider's connections; its switch turns them all off or on.
 */
export function Providers() {
  useLang();
  const [providers, reloadProviders] = useLoad<Provider[]>("/providers");
  const [connections, reloadConnections] = useLoad<Connection[]>("/connections");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    reloadProviders();
    reloadConnections();
  };

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
      <PageHeader
        title={t("providers.title")}
        description={t("providers.description")}
        actions={
          <>
            <SearchInput size="md" aria-label={t("providers.search")} placeholder={t("providers.search")} value={query} onChange={(e) => setQuery(e.target.value)} onClear={() => setQuery("")} />
            <Select
              aria-label={t("providers.filter")}
              icon="filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
              options={FILTERS.map((f) => ({ value: f, label: t(`providers.filter.${f}`) }))}
            />
          </>
        }
      />
      {error && <Banner tone="danger" title={error} />}
      {(providers.status === "loading" || connections.status === "loading") && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
      {(providers.status === "error" || connections.status === "error") && (
        <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />
      )}
      {ready && shown.length === 0 && <EmptyState icon="search" title={t("providers.noMatch")} />}
      {SECTIONS.map(({ kind, title }) => {
        const cards = shown.filter(({ provider }) => (provider.auth[0] ?? "api_key") === kind);
        if (cards.length === 0) return null;
        return (
          <section key={kind} className="providers-section">
            <div className="providers-section-head">
              <h2 className="providers-section-title">{t(title)}</h2>
              <span className="providers-section-count">{cards.length}</span>
            </div>
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
          </section>
        );
      })}
    </Stack>
  );
}

type Pending = { kind: "edit"; account: Connection | null } | { kind: "delete"; account: Connection } | { kind: "oauth"; url: string } | null;

/** One provider's accounts, in the order the gateway tries them: add, rename, replace a key, switch off, reorder, delete. */
export function ProviderDetail({ id }: { id: string }) {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [providers, reloadProviders] = useLoad<Provider[]>("/providers");
  const [connections, reload] = useLoad<Connection[]>("/connections");
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

  /** A subscription provider has no key to type: its sign-in page opens in a new tab, and a dialog waits for the result. */
  const startSignIn = () =>
    run(async () => {
      const { authorize_url } = await api<{ authorize_url: string }>(`/oauth/${encodeURIComponent(id)}/start`, { method: "POST" });
      window.open(authorize_url, "_blank", "noopener");
      setPending({ kind: "oauth", url: authorize_url });
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
        <Emblem name={provider?.name ?? id} text={provider?.mark} color={provider?.color} src={providerLogo(id)} size="lg" />
        <PageHeader
          title={provider?.name ?? id}
          description={loaded ? t("providers.connections", { n: String(mine.length) }) : undefined}
          actions={
            provider?.key_url ? (
              <a className="back-link" href={provider.key_url} target="_blank" rel="noreferrer noopener">
                <Icon name="external" size={16} />
                {isOAuth ? t("providers.signUp") : t("providers.getKey")}
              </a>
            ) : undefined
          }
        />
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
          {provider.env_key && <Banner tone="info" title={t("providers.envKeyNote")} />}
          <Card
            title={t("providers.accountsTitle")}
            subtitle={accounts.length > 1 ? t("providers.accountsHint") : undefined}
            actions={
              <>
                <Switch label={t("providers.roundRobin")} checked={provider.strategy === "round-robin"} disabled={busy} onChange={(e) => void setRoundRobin(e.target.checked)} />
                <Button variant="primary" icon="plus" disabled={busy} onClick={() => (isOAuth ? void startSignIn() : setPending({ kind: "edit", account: null }))}>
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
      {pending?.kind === "edit" && (
        <AccountDialog
          provider={id}
          account={pending.account}
          onCancel={() => setPending(null)}
          onSaved={(name) => {
            notify(t("providers.savedNotice", { name }));
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
    </Stack>
  );
}

/** Adds an account, or renames one and replaces its key. The key is sent once and never read back. */
function AccountDialog({ provider, account, onCancel, onSaved }: { provider: string; account: Connection | null; onCancel: () => void; onSaved: (name: string) => void }) {
  const [lang] = useLang();
  const [name, setName] = useState(account?.name ?? "");
  const [apiKey, setApiKey] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = name.trim() !== "" && name.length <= 100;
  // A new account needs a key; an existing one keeps its key when the field is left empty.
  const keyOk = account ? true : apiKey.trim() !== "";

  async function submit() {
    setTried(true);
    if (!nameOk || !keyOk) return;
    setBusy(true);
    setError(null);
    try {
      const key = apiKey.trim();
      if (account) {
        await api(`/connections/${encodeURIComponent(account.id)}`, { method: "PATCH", body: { name: name.trim(), ...(key ? { api_key: key } : {}) } });
      } else {
        await api("/connections", { body: { provider, name: name.trim(), api_key: key } });
      }
      onSaved(name.trim());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.code === "not_configured" ? t("providers.notConfigured") : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={account ? t("providers.editTitle", { name: account.name }) : t("providers.add")}
      submitLabel={t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field
        label={t("providers.name")}
        hint={t("providers.nameHint")}
        value={name}
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
        error={tried && !nameOk ? t("providers.nameRequired") : undefined}
      />
      {account?.auth_type !== "oauth" && (
        <Field
          label={t("providers.apiKey")}
          hint={account ? t("providers.apiKeyKeepHint") : t("providers.apiKeyHint")}
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setApiKey(e.target.value)}
          error={tried && !keyOk ? t("providers.apiKeyRequired") : undefined}
        />
      )}
    </FormDialog>
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
        hint={t("providers.oauth.callbackHint")}
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

