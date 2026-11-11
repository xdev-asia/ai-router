import { useState } from "react";
import { Banner, Button, Card, DataTable, Dialog, EmptyState, Field, FormDialog, MenuButton, PageHeader, Skeleton, Stack, Textarea, type DataTableColumn } from "@xdev-asia/ui";
import { ApiError, COMBO_NAME, TARGET, api, splitList, useLoad, type Combo } from "../api";
import { t, useLang } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";

type Pending = { kind: "edit"; combo: Combo | null } | { kind: "delete"; combo: Combo } | null;

/** Combos: `combo/<name>` tries its targets in order, moving on after a 429, a 5xx or a missing key. */
export function Combos() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [combos, reload] = useLoad<Combo[]>("/combos");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(combo: Combo) {
    setBusy(true);
    setError(null);
    try {
      await api(`/combos/${encodeURIComponent(combo.name)}`, { method: "DELETE" });
      notify(t("combos.deletedNotice", { name: combo.name }));
      setPending(null);
      reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const columns: DataTableColumn<Combo>[] = [
    { key: "name", header: t("combos.col.name"), mono: true, cell: (c) => `combo/${c.name}` },
    {
      key: "targets",
      header: t("combos.col.targets"),
      cell: (c) => (
        <ol className="combo-targets">
          {c.targets.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ol>
      ),
    },
    {
      key: "actions",
      header: <span className="x-sr-only">{t("systems.col.actions")}</span>,
      width: "min",
      cell: (c) => (
        <MenuButton
          variant="icon"
          align="end"
          label={`${t("systems.col.actions")}: ${c.name}`}
          disabled={busy}
          items={[
            { label: t("combos.edit"), onSelect: () => setPending({ kind: "edit", combo: c }) },
            { type: "separator" },
            { label: t("combos.delete"), danger: true, onSelect: () => setPending({ kind: "delete", combo: c }) },
          ]}
        />
      ),
    },
  ];

  return (
    <Stack gap={4}>
      <PageHeader
        title={t("combos.title")}
        description={t("combos.description")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setPending({ kind: "edit", combo: null })}>
            {t("combos.add")}
          </Button>
        }
      />
      {error && <Banner tone="danger" title={error} />}
      <Card flush>
        {combos.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
        {combos.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
        {combos.status === "ready" && (
          <DataTable
            caption={t("combos.caption")}
            columns={columns}
            rows={combos.data}
            rowKey={(c) => c.name}
            labels={labels.dataTable}
            empty={<EmptyState icon="list" title={t("combos.empty")} />}
          />
        )}
      </Card>
      {pending?.kind === "edit" && (
        <ComboDialog
          combo={pending.combo}
          onCancel={() => setPending(null)}
          onSaved={(name) => {
            notify(t("combos.savedNotice", { name }));
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
          title={t("combos.deleteTitle", { name: pending.combo.name })}
          labels={labels.dialog}
          confirmLabel={t("combos.delete")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void remove(pending.combo)}
        >
          {t("combos.deleteBody")}
        </Dialog>
      )}
    </Stack>
  );
}

function ComboDialog({ combo, onCancel, onSaved }: { combo: Combo | null; onCancel: () => void; onSaved: (name: string) => void }) {
  const [lang] = useLang();
  const [name, setName] = useState(combo?.name ?? "");
  const [targets, setTargets] = useState(combo?.targets.join("\n") ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = splitList(targets);
  const nameOk = COMBO_NAME.test(name);
  const bad = list.filter((x) => !TARGET.test(x));
  const targetsOk = list.length >= 1 && list.length <= 10 && bad.length === 0;

  async function submit() {
    setTried(true);
    if (!nameOk || !targetsOk) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/combos/${encodeURIComponent(name)}`, { method: "PUT", body: { targets: list } });
      onSaved(name);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={combo ? t("combos.editTitle", { name: combo.name }) : t("combos.add")}
      description={t("combos.dialogDescription")}
      submitLabel={t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field
        label={t("combos.name")}
        hint={t("combos.nameHint")}
        value={name}
        readOnly={combo !== null}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        error={tried && !nameOk ? t("combos.nameHint") : undefined}
      />
      <Textarea
        label={t("combos.targets")}
        hint={t("combos.targetsHint")}
        mono
        rows={5}
        spellCheck={false}
        value={targets}
        onChange={(e) => setTargets(e.target.value)}
        error={tried && !targetsOk ? (bad.length ? t("settings.modelsBad", { bad: bad.join(", ") }) : t("combos.targetsHint")) : undefined}
      />
    </FormDialog>
  );
}
