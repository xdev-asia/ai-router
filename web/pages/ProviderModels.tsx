import { useState } from "react";
import { Banner, Button, Card, Dialog, Field, FormDialog, IconButton, ModelChip, ModelChipAdd, Select, Skeleton } from "@xdev-asia/ui";
import { ApiError, api, useLoad, type ProviderModel, type ProviderModels as Models } from "../api";
import { t, useLang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";

/** The name a model alias points at, without its `(level)` and `[1m]` markers. */
const bare = (model: string) => model.replace(/\[1m\]$/i, "").replace(/\([^()]*\)\s*$/, "").replace(/\[1m\]$/i, "");

const LEVELS = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
const levelLabel = (mode: string) => (LEVELS.includes(mode) ? t(`models.level.${mode}` as StringKey) : mode);

type Pending = { kind: "add" } | { kind: "disableAll"; ids: string[] } | { kind: "alias"; model: ProviderModel; current: string | null } | null;

/**
 * A provider's Available Models card (FR-CON-11, FR-MDL-05..12): each model's id to copy, test,
 * hide or give an alias; Disable All and Active All; the provider's Thinking mode; and models the owner adds.
 */
export function ProviderModelsCard({ provider }: { provider: string }) {
  const [lang] = useLang();
  const notify = useNotify();
  const [data, reload] = useLoad<Models>(`/providers/${encodeURIComponent(provider)}/models`);
  const [aliases, reloadAliases] = useLoad<{ aliases: Record<string, string> }>("/models/aliases");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (data.status === "loading") return <Skeleton lines={2} announce labels={{ loading: t("loading") }} />;
  if (data.status === "error") return <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />;
  const { alias, thinking, models } = data.data;
  const code = (m: ProviderModel) => `${alias}/${m.id}`;
  const mode = thinking?.mode ?? "auto";
  /** The name copied: with the `(level)` suffix when a Thinking mode is set and the model takes it (FR-MDL-11). */
  const copyName = (m: ProviderModel) => (mode !== "auto" && m.thinking?.includes(mode) ? `${code(m)}(${mode})` : code(m));
  const aliasOf = (m: ProviderModel): string | null => {
    if (aliases.status !== "ready") return null;
    const names = new Set([code(m), `${provider}/${m.id}`]);
    return Object.entries(aliases.data.aliases).find(([, target]) => names.has(bare(target)))?.[0] ?? null;
  };
  const off = models.filter((m) => m.disabled);
  const on = models.filter((m) => !m.disabled);

  async function copy(m: ProviderModel) {
    const name = copyName(m);
    try {
      await navigator.clipboard.writeText(name);
      notify(t("models.copied", { name }));
    } catch {
      setError(t("error.generic"));
    }
  }

  const setThinking = (next: string) =>
    run(async () => {
      await api("/models/thinking", { method: "PUT", body: { provider, mode: next } });
      reload();
    });

  const setDisabled = (m: ProviderModel, disabled: boolean) =>
    run(async () => {
      if (disabled) await api("/models/disabled", { body: { provider, ids: [m.id] } });
      else await api(`/models/disabled?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
      reload();
    });

  const disableAll = (ids: string[]) =>
    run(async () => {
      await api("/models/disabled", { body: { provider, ids } });
      setPending(null);
      reload();
    });

  const activeAll = () =>
    run(async () => {
      await api(`/models/disabled?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
      reload();
    });

  const remove = (m: ProviderModel) =>
    run(async () => {
      await api(`/models/custom?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
      notify(t("models.removed", { name: code(m) }));
      reload();
    });

  /** Sends "hi" to the model through the gateway and says how it went. */
  async function test(m: ProviderModel) {
    setTesting(m.id);
    try {
      const r = await api<{ ok: boolean; error?: string; latency_ms?: number }>("/models/test", { body: { model: code(m) } });
      notify(r.ok ? t("models.testOk", { name: code(m), ms: String(r.latency_ms ?? 0) }) : t("models.testFailed", { name: code(m), error: r.error ?? "" }));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setTesting(null);
    }
  }

  return (
    <Card
      title={t("models.title")}
      titleAside={
        thinking && (
          <Select
            aria-label={t("models.thinking")}
            value={mode}
            disabled={busy}
            onChange={(e) => void setThinking(e.target.value)}
            options={thinking.options.map((o) => ({ value: o, label: t("models.thinkingOption", { level: levelLabel(o) }) }))}
          />
        )
      }
      actions={
        <>
          {off.length > 0 && (
            <Button icon="eye" disabled={busy} onClick={() => void activeAll()}>
              {t("models.activeAll")}
            </Button>
          )}
          {on.length > 0 && (
            <Button icon="eye-off" disabled={busy} onClick={() => setPending({ kind: "disableAll", ids: on.map((m) => m.id) })}>
              {t("models.disableAll")}
            </Button>
          )}
        </>
      }
    >
      {error && <Banner tone="danger" title={error} />}
      <div className="models-list" role="list" aria-label={t("models.title")}>
        {models.map((m) => {
          const a = aliasOf(m);
          return (
            <div role="listitem" key={m.id} className="models-item">
              <ModelChip
                code={code(m)}
                dimmed={m.disabled}
                name={a ? `${m.name} · ${a}` : m.name}
                codeAction={<IconButton size="sm" icon="copy" label={t("models.copy", { name: copyName(m) })} onClick={() => void copy(m)} />}
                actions={
                  <>
                    <IconButton
                      size="sm"
                      icon={m.disabled ? "eye-off" : "eye"}
                      label={m.disabled ? t("models.show", { name: code(m) }) : t("models.hide", { name: code(m) })}
                      disabled={busy}
                      onClick={() => void setDisabled(m, !m.disabled)}
                    />
                    <IconButton
                      size="sm"
                      icon={testing === m.id ? "clock" : "play"}
                      label={t("models.test", { name: code(m) })}
                      disabled={testing !== null || m.disabled}
                      onClick={() => void test(m)}
                    />
                    <IconButton size="sm" icon="tag" label={t("models.alias", { name: code(m) })} disabled={busy} onClick={() => setPending({ kind: "alias", model: m, current: a })} />
                    {m.custom && <IconButton size="sm" icon="trash" label={t("models.remove", { name: code(m) })} disabled={busy} onClick={() => void remove(m)} />}
                  </>
                }
              />
            </div>
          );
        })}
        <div role="listitem" className="models-item">
          <ModelChipAdd label={t("models.add")} onClick={() => setPending({ kind: "add" })} />
        </div>
      </div>
      {pending?.kind === "disableAll" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("models.disableAllTitle")}
          labels={ui(lang).dialog}
          confirmLabel={t("models.disableAll")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void disableAll(pending.ids)}
        >
          {t("models.disableAllBody", { n: String(pending.ids.length) })}
        </Dialog>
      )}
      {pending?.kind === "add" && (
        <AddModelDialog
          provider={provider}
          onCancel={() => setPending(null)}
          onSaved={(id) => {
            notify(t("models.added", { name: `${alias}/${id}` }));
            setPending(null);
            reload();
          }}
        />
      )}
      {pending?.kind === "alias" && (
        <AliasDialog
          target={code(pending.model)}
          current={pending.current}
          onCancel={() => setPending(null)}
          onSaved={(message) => {
            notify(message);
            setPending(null);
            reloadAliases();
          }}
        />
      )}
    </Card>
  );
}

/** "Add Custom Model": an id the provider takes, and a name to show for it. */
function AddModelDialog({ provider, onCancel, onSaved }: { provider: string; onCancel: () => void; onSaved: (id: string) => void }) {
  const [lang] = useLang();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idOk = /^[A-Za-z0-9._:[\]-]+(\/[A-Za-z0-9._:[\]-]+)*$/.test(id.trim());

  async function submit() {
    setTried(true);
    if (!idOk) return;
    setBusy(true);
    setError(null);
    try {
      await api("/models/custom", { body: { provider, id: id.trim(), ...(name.trim() ? { name: name.trim() } : {}) } });
      onSaved(id.trim());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog title={t("models.addTitle")} submitLabel={t("models.add")} labels={ui(lang).formDialog} busy={busy} error={error ?? undefined} onCancel={onCancel} onSubmit={() => void submit()}>
      <Field
        label={t("models.id")}
        hint={t("models.idHint")}
        value={id}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setId(e.target.value)}
        error={tried && !idOk ? t("models.idRequired") : undefined}
      />
      <Field label={t("models.displayName")} hint={t("models.displayNameHint")} value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
    </FormDialog>
  );
}

/** Gives a model a short name clients can send instead (FR-MDL-04, 09); an empty name removes the alias. */
function AliasDialog({ target, current, onCancel, onSaved }: { target: string; current: string | null; onCancel: () => void; onSaved: (message: string) => void }) {
  const [lang] = useLang();
  const [alias, setAlias] = useState(current ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = alias.trim();
  const ok = value === "" ? current !== null : /^[A-Za-z0-9._-]{1,64}$/.test(value);

  async function submit() {
    setTried(true);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      if (current && current !== value) await api(`/models/aliases?alias=${encodeURIComponent(current)}`, { method: "DELETE" });
      if (value) await api("/models/aliases", { method: "PUT", body: { alias: value, model: target } });
      onSaved(value ? t("models.aliasSaved", { alias: value, name: target }) : t("models.aliasRemoved", { alias: current ?? "" }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={t("models.aliasTitle", { name: target })}
      submitLabel={t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field
        label={t("models.aliasField")}
        hint={t("models.aliasHint")}
        value={alias}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setAlias(e.target.value)}
        error={tried && !ok ? t("models.aliasInvalid") : undefined}
      />
    </FormDialog>
  );
}
