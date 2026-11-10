import { useState } from "react";
import {
  Banner,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FormDialog,
  MenuButton,
  Meter,
  PageHeader,
  Skeleton,
  Stack,
  StatusDot,
  type DataTableColumn,
} from "@xdev-asia/ui";
import { ApiError, api, capTokens, useLoad, type System, type UsageReport } from "../api";
import { formatNumber, t, useLang } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";
import { TokenDialog } from "./TokenDialog";

const ID = /^[a-z][a-z0-9-]{1,31}$/;

/** "" -> null (no cap); a non-negative integer -> the number; anything else -> undefined (invalid). */
export function parseCap(raw: string): number | null | undefined {
  const s = raw.trim();
  if (s === "") return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

type Pending =
  | { kind: "create" }
  | { kind: "cap"; system: System }
  | { kind: "rotate"; system: System }
  | { kind: "disable"; system: System }
  | { kind: "token"; id: string; token: string }
  | null;

export function Systems() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [systems, reload] = useLoad<System[]>("/systems");
  const [usage, reloadUsage] = useLoad<UsageReport>("/usage");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const used = new Map<string, number>();
  if (usage.status === "ready") for (const r of usage.data.rows) used.set(r.system_id, (used.get(r.system_id) ?? 0) + capTokens(r));

  async function run<T>(work: () => Promise<T>, after: (v: T) => void) {
    setBusy(true);
    setError(null);
    try {
      after(await work());
      reload();
      reloadUsage();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const setDisabled = (s: System, disabled: boolean) =>
    run(
      () => api(`/systems/${encodeURIComponent(s.id)}`, { method: "PATCH", body: { disabled } }),
      () => {
        setPending(null);
        notify(t(disabled ? "systems.disabledNotice" : "systems.enabledNotice", { id: s.id }));
      },
    );

  const columns: DataTableColumn<System>[] = [
    { key: "id", header: t("systems.col.id"), cell: (s) => s.id, mono: true },
    { key: "name", header: t("systems.col.name"), cell: (s) => s.name, hideNarrow: true },
    {
      key: "month",
      header: t("systems.col.month"),
      cell: (s) => {
        const n = used.get(s.id) ?? 0;
        if (s.monthly_token_cap === null) return formatNumber(n);
        const pct = s.monthly_token_cap === 0 ? 100 : Math.min(100, Math.round((n / s.monthly_token_cap) * 100));
        // Meter shows its label and the percentage itself.
        return <Meter value={pct} warnAt={80} label={t("systems.used", { used: formatNumber(n), cap: formatNumber(s.monthly_token_cap) })} />;
      },
    },
    {
      key: "cap",
      header: t("systems.col.cap"),
      align: "end",
      hideNarrow: true,
      cell: (s) => (s.monthly_token_cap === null ? t("systems.noCap") : formatNumber(s.monthly_token_cap)),
    },
    {
      key: "status",
      header: t("systems.col.status"),
      cell: (s) => <StatusDot tone={s.disabled ? "neutral" : "ok"} label={t(s.disabled ? "systems.disabled" : "systems.active")} />,
    },
    {
      key: "actions",
      header: <span className="x-sr-only">{t("systems.col.actions")}</span>,
      width: "min",
      cell: (s) => (
        <MenuButton
          variant="icon"
          align="end"
          label={`${t("systems.col.actions")}: ${s.id}`}
          disabled={busy}
          items={[
            { label: t("systems.editCap"), onSelect: () => setPending({ kind: "cap", system: s }) },
            { label: t("systems.rotate"), onSelect: () => setPending({ kind: "rotate", system: s }) },
            { type: "separator" },
            s.disabled
              ? { label: t("systems.enable"), onSelect: () => void setDisabled(s, false) }
              : { label: t("systems.disable"), danger: true, onSelect: () => setPending({ kind: "disable", system: s }) },
          ]}
        />
      ),
    },
  ];

  return (
    <Stack gap={4}>
      <PageHeader
        title={t("systems.title")}
        description={t("systems.description")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setPending({ kind: "create" })}>
            {t("systems.add")}
          </Button>
        }
      />
      {error && <Banner tone="danger" title={error} />}
      <Card flush>
        {systems.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
        {systems.status === "error" && (
          <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />
        )}
        {systems.status === "ready" && (
          <DataTable
            caption={t("systems.caption")}
            columns={columns}
            rows={systems.data}
            rowKey={(s) => s.id}
            labels={labels.dataTable}
            empty={<EmptyState icon="server" title={t("systems.empty")} />}
          />
        )}
      </Card>

      {pending?.kind === "create" && (
        <CreateDialog
          onCancel={() => setPending(null)}
          onCreated={(id, token) => {
            setPending({ kind: "token", id, token });
            reload();
          }}
        />
      )}
      {pending?.kind === "cap" && (
        <CapDialog
          system={pending.system}
          onCancel={() => setPending(null)}
          onSaved={() => {
            notify(t("systems.capNotice", { id: pending.system.id }));
            setPending(null);
            reload();
          }}
        />
      )}
      {pending?.kind === "rotate" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("systems.rotateTitle", { id: pending.system.id })}
          labels={labels.dialog}
          confirmLabel={t("systems.rotate")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() =>
            void run(
              () => api<{ id: string; token: string }>(`/systems/${encodeURIComponent(pending.system.id)}/rotate`, { method: "POST" }),
              (r) => setPending({ kind: "token", id: r.id, token: r.token }),
            )
          }
        >
          {t("systems.rotateBody")}
        </Dialog>
      )}
      {pending?.kind === "disable" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("systems.disableTitle", { id: pending.system.id })}
          labels={labels.dialog}
          confirmLabel={t("systems.disable")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void setDisabled(pending.system, true)}
        >
          {t("systems.disableBody")}
        </Dialog>
      )}
      {pending?.kind === "token" && <TokenDialog id={pending.id} token={pending.token} onClose={() => setPending(null)} />}
    </Stack>
  );
}

function CreateDialog({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string, token: string) => void }) {
  const [lang] = useLang();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [cap, setCap] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idOk = ID.test(id);
  const nameOk = name.trim() !== "" && name.length <= 100;
  const capValue = parseCap(cap);

  async function submit() {
    setTried(true);
    if (!idOk || !nameOk || capValue === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string; token: string }>("/systems", { body: { id, name: name.trim(), monthly_token_cap: capValue } });
      onCreated(r.id, r.token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.code === "exists" ? t("create.exists") : e instanceof ApiError && e.status === 400 ? t("create.badInput") : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={t("create.title")}
      description={t("create.description")}
      submitLabel={t("create.submit")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field
        label={t("create.id")}
        hint={t("create.idHint")}
        value={id}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setId(e.target.value)}
        error={tried && !idOk ? t("create.idHint") : undefined}
      />
      <Field label={t("create.name")} value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} error={tried && !nameOk ? t("create.badInput") : undefined} />
      <Field
        label={t("create.cap")}
        hint={t("create.capHint")}
        inputMode="numeric"
        value={cap}
        onChange={(e) => setCap(e.target.value)}
        error={tried && capValue === undefined ? t("create.capHint") : undefined}
      />
    </FormDialog>
  );
}

function CapDialog({ system, onCancel, onSaved }: { system: System; onCancel: () => void; onSaved: () => void }) {
  const [lang] = useLang();
  const [cap, setCap] = useState(system.monthly_token_cap === null ? "" : String(system.monthly_token_cap));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = parseCap(cap);

  async function submit() {
    setTried(true);
    if (value === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/systems/${encodeURIComponent(system.id)}`, { method: "PATCH", body: { monthly_token_cap: value } });
      onSaved();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={t("cap.title", { id: system.id })}
      submitLabel={t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field
        label={t("create.cap")}
        hint={t("create.capHint")}
        inputMode="numeric"
        value={cap}
        onChange={(e) => setCap(e.target.value)}
        error={tried && value === undefined ? t("create.capHint") : undefined}
      />
    </FormDialog>
  );
}
