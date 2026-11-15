import { useMemo, useState } from "react";
import {
  Banner,
  Button,
  BulkBar,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FieldMessage,
  FormDialog,
  IconButton,
  SearchInput,
  SearchPicker,
  Skeleton,
  Select,
  SettingRow,
  SortableList,
  Stack,
  Switch,
  moveItem,
  type DataTableColumn,
  type SearchPickerItem,
} from "@xdev-asia/ui";
import {
  ApiError,
  COMBO_NAME,
  COMBO_STRATEGIES,
  COMBO_TAKEN,
  ROUTER_POLICIES,
  TARGET,
  api,
  memberCombo,
  useLoad,
  type Combo,
  type ComboConfig,
  type ComboStrategy,
  type RouterPolicy,
} from "../api";
import { t, useLang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";
import { useHashParams } from "../url-state";

const MAX_MODELS = 50;
const PREVIEW = 3;

type Pending = { kind: "edit"; combo: Combo | null } | { kind: "delete"; combos: Combo[] } | null;

/** Combos whose name or a model contains the query, ignoring case. */
export function filterCombos(combos: readonly Combo[], query: string): Combo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...combos];
  return combos.filter((c) => c.name.toLowerCase().includes(q) || c.targets.some((m) => m.toLowerCase().includes(q)));
}

/** The first models a row shows, and how many it leaves out. */
export function previewModels(targets: readonly string[]): { shown: string[]; more: number } {
  return { shown: targets.slice(0, PREVIEW), more: Math.max(0, targets.length - PREVIEW) };
}

/**
 * What "Add Model" offers: the typed model when it is valid, then other combos and the models other combos use.
 * Nothing already in the list, and never the combo being edited.
 */
export function pickerItems(query: string, current: readonly string[], combos: readonly Combo[], self: string | null): SearchPickerItem[] {
  const q = query.trim();
  const names = new Set(combos.map((c) => c.name));
  const inList = new Set(current.map((m) => memberCombo(m, names) ?? `\0${m}`));
  const taken = (id: string) => current.includes(id) || inList.has(memberCombo(id, names) ?? `\0${id}`);
  const out: SearchPickerItem[] = [];
  const seen = new Set<string>();
  const push = (id: string, meta?: string) => {
    if (seen.has(id) || taken(id)) return;
    seen.add(id);
    out.push({ id, title: <span className="combo-model">{id}</span>, meta });
  };
  if (q && TARGET.test(q)) push(q, t("combos.pickTyped"));
  const match = (id: string) => !q || id.toLowerCase().includes(q.toLowerCase());
  for (const c of [...combos].sort((a, b) => a.name.localeCompare(b.name))) {
    if (c.name !== self && match(`combo/${c.name}`)) push(`combo/${c.name}`, t("combos.pickCombo"));
  }
  const models = new Set(combos.flatMap((c) => c.targets).filter((m) => memberCombo(m, names) === null));
  for (const m of [...models].sort()) if (match(m)) push(m);
  return out;
}

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
const POLICY_LABEL: Record<RouterPolicy, StringKey> = {
  smart: "combos.policy.smart",
  strict: "combos.policy.strict",
  "per-turn": "combos.policy.perTurn",
  custom: "combos.policy.custom",
};
const POLICY_HINT: Record<RouterPolicy, StringKey> = {
  smart: "combos.policyHint.smart",
  strict: "combos.policyHint.strict",
  "per-turn": "combos.policyHint.perTurn",
  custom: "combos.policyHint.custom",
};

/** The strategy part of the combo dialog, as typed. `strategy` "": the gateway-wide one. */
export interface StrategyDraft {
  strategy: ComboStrategy | "";
  router: string;
  policy: RouterPolicy;
  threshold: string;
  judge: string;
}

export function strategyDraft(combo: Combo | null): StrategyDraft {
  const c = combo?.config ?? {};
  return {
    strategy: combo?.strategy ?? "",
    router: c.router_model ?? "",
    policy: c.policy ?? "smart",
    threshold: String(c.threshold ?? 0.8),
    judge: c.judge_model ?? "",
  };
}

/** A model the router or judge field takes: provider/model or claude-*, never a combo. */
const isModel = (v: string) => TARGET.test(v) && !v.startsWith("combo/");

export type StrategyBody = { strategy: ComboStrategy | null; config: ComboConfig | null } | { bad: "router" | "judge" | "threshold" };

/** What the gateway is sent for the draft, or the field that is wrong. Only the chosen strategy's settings go. */
export function strategyBody(d: StrategyDraft): StrategyBody {
  const router = d.router.trim();
  const judge = d.judge.trim();
  if (d.strategy === "smart") {
    if (router && !isModel(router)) return { bad: "router" };
    const config: ComboConfig = { router_model: router || null, policy: d.policy };
    if (d.policy === "custom") {
      const n = Number(d.threshold);
      if (!d.threshold.trim() || !Number.isFinite(n) || n < 0.5 || n > 0.95) return { bad: "threshold" };
      config.threshold = n;
    }
    return { strategy: "smart", config };
  }
  if (d.strategy === "fusion") {
    if (judge && !isModel(judge)) return { bad: "judge" };
    return { strategy: "fusion", config: { judge_model: judge || null } };
  }
  return { strategy: d.strategy || null, config: null };
}

/** The vision adapter (worker/vision.ts): a pool of models that describe images for models that cannot read them. */
export interface VisionAdapter {
  enabled: boolean;
  models: string[];
  applies_to: string[];
}
export const MAX_ADAPTER_MODELS = 10;
export const MAX_APPLIES_TO = 50;
/** An applies-to entry: a model, `combo/<name>`, `provider/*`, `combo/*` or `*` (worker/vision.ts appliesEntry). */
const isAppliesEntry = (v: string) => v === "*" || /^[a-z][a-z0-9-]*\/\*$/.test(v) || TARGET.test(v);

/**
 * What "Add model" offers in the vision adapter's lists. `pool`: the typed model, then the models combos use.
 * `targets`: the typed entry (a model, a combo, `provider/*` or `*`), `*`, every combo, then the models combos use.
 * Nothing already in the list.
 */
export function visionPickerItems(query: string, current: readonly string[], combos: readonly Combo[], list: "pool" | "targets"): SearchPickerItem[] {
  const q = query.trim();
  const names = new Set(combos.map((c) => c.name));
  const out: SearchPickerItem[] = [];
  const seen = new Set(current);
  const push = (id: string, meta?: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, title: <span className="combo-model">{id}</span>, meta });
  };
  const match = (id: string) => !q || id.toLowerCase().includes(q.toLowerCase());
  if (q && (list === "pool" ? isModel(q) : isAppliesEntry(q))) push(q, t("combos.pickTyped"));
  if (list === "targets") {
    if (match("*")) push("*", t("combos.vision.all"));
    for (const c of [...combos].sort((a, b) => a.name.localeCompare(b.name))) if (match(`combo/${c.name}`)) push(`combo/${c.name}`, t("combos.pickCombo"));
  }
  const models = new Set(combos.flatMap((c) => c.targets).filter((m) => memberCombo(m, names) === null));
  for (const m of [...models].sort()) if (match(m)) push(m);
  return out;
}

/** Whether the lists as edited differ from the saved ones. */
export const visionChanged = (saved: VisionAdapter, models: readonly string[], targets: readonly string[]): boolean =>
  JSON.stringify([saved.models, saved.applies_to]) !== JSON.stringify([models, targets]);

/** The PUT body for the edited lists: the adapter stays on only while both lists have an entry (the gateway needs both). */
export function visionBody(saved: VisionAdapter, models: readonly string[], targets: readonly string[]): VisionAdapter {
  return { enabled: saved.enabled && models.length > 0 && targets.length > 0, models: [...models], applies_to: [...targets] };
}

/** The search lives in the address (`#/combos?q=fast`). */
const SEARCH_DEFAULT = { q: "" };

/** Combos: one name for an ordered list of models; the gateway tries the next after a rate limit, a server error or a missing key. */
export function Combos() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [combos, reload] = useLoad<Combo[]>("/combos");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [{ q: query }, setParams] = useHashParams("#/combos", SEARCH_DEFAULT);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** A new search starts with nothing picked, so a bulk action never reaches rows the owner can no longer see. */
  const setQuery = (q: string) => {
    setParams({ q });
    setSelected(new Set());
  };
  const closeDialog = () => {
    setPending(null);
    setDialogError(null);
  };

  const all = combos.status === "ready" ? combos.data : [];
  const shown = useMemo(() => filterCombos(all, query), [all, query]);

  async function remove(list: Combo[]) {
    setBusy(true);
    setError(null);
    setDialogError(null);
    try {
      for (const c of list) await api(`/combos/${encodeURIComponent(c.name)}`, { method: "DELETE" });
      notify(list.length === 1 ? t("combos.deletedNotice", { name: list[0].name }) : t("combos.deletedMany", { n: String(list.length) }));
      closeDialog();
      setSelected(new Set());
      reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setDialogError(t("error.generic"));
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function copy(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      notify(t("combos.copied", { name }));
    } catch {
      setError(t("error.generic"));
    }
  }

  const columns: DataTableColumn<Combo>[] = [
    { key: "name", header: t("combos.col.name"), mono: true, cell: (c) => c.name },
    {
      key: "targets",
      header: t("combos.col.targets"),
      cell: (c) => {
        const { shown: models, more } = previewModels(c.targets);
        if (models.length === 0) return <span className="combo-none">{t("combos.noModels")}</span>;
        return (
          <span className="combo-preview">
            {models.map((m) => (
              <span key={m} className="combo-model">
                {m}
              </span>
            ))}
            {more > 0 && <span className="combo-more">{t("combos.more", { n: String(more) })}</span>}
          </span>
        );
      },
    },
    {
      key: "strategy",
      header: t("combos.col.strategy"),
      cell: (c) => (c.strategy ? t(STRATEGY_LABEL[c.strategy]) : <span className="combo-none">{t("combos.strategy.default")}</span>),
    },
    {
      key: "actions",
      header: <span className="x-sr-only">{t("systems.col.actions")}</span>,
      width: "min",
      cell: (c) => (
        <span className="combo-actions">
          <IconButton icon="copy" label={t("combos.copy", { name: c.name })} onClick={() => void copy(c.name)} />
          <IconButton icon="edit" label={t("combos.editOne", { name: c.name })} disabled={busy} onClick={() => setPending({ kind: "edit", combo: c })} />
          <IconButton icon="trash" label={t("combos.deleteOne", { name: c.name })} disabled={busy} onClick={() => setPending({ kind: "delete", combos: [c] })} />
        </span>
      ),
    },
  ];

  const create = (
    <Button variant="primary" icon="plus" onClick={() => setPending({ kind: "edit", combo: null })}>
      {t("combos.add")}
    </Button>
  );
  const picked = all.filter((c) => selected.has(c.name));

  return (
    <Stack gap={4}>
      <div className="page-actions">
        <div className="page-intro">
          <p className="combo-intro">{t("combos.intro")}</p>
          <dl className="combo-strategies">
            {COMBO_STRATEGIES.map((s) => (
              <div key={s}>
                <dt>{t(STRATEGY_LABEL[s])}</dt>
                <dd>{t(STRATEGY_HINT[s])}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="combo-tools">
          <SearchInput
            size="md"
            aria-label={t("combos.searchLabel")}
            placeholder={t("combos.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            labels={labels.searchInput}
          />
          {create}
        </div>
      </div>
      {error && <Banner tone="danger" title={error} />}
      {query.trim() !== "" && all.length > 0 && (
        <p className="combo-count" role="status">
          {t("combos.shown", { n: String(shown.length), total: String(all.length) })}
        </p>
      )}
      <BulkBar count={picked.length} onClear={() => setSelected(new Set())} labels={labels.bulkBar}>
        <Button variant="danger" icon="trash" disabled={busy} onClick={() => setPending({ kind: "delete", combos: picked })}>
          {t("combos.deleteSelected", { n: String(picked.length) })}
        </Button>
      </BulkBar>
      {combos.status === "ready" && all.length === 0 ? (
        <Card>
          <EmptyState
            size="center"
            icon="layers"
            title={t("combos.empty")}
            hint={t("combos.emptyHint")}
            actions={
              <Button icon="plus" onClick={() => setPending({ kind: "edit", combo: null })}>
                {t("combos.add")}
              </Button>
            }
          />
        </Card>
      ) : (
      <Card flush>
        {combos.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
        {combos.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
        {combos.status === "ready" && (
          <DataTable
            caption={t("combos.caption")}
            columns={columns}
            rows={shown}
            rowKey={(c) => c.name}
            rowLabel={(c) => c.name}
            selected={selected}
            onSelectedChange={setSelected}
            labels={labels.dataTable}
            empty={
              <EmptyState
                icon="search"
                title={t("combos.noMatch", { q: query.trim() })}
                actions={<Button onClick={() => setQuery("")}>{t("combos.clearSearch")}</Button>}
              />
            }
          />
        )}
      </Card>
      )}
      <AdapterCard kind="vision" combos={all} />
      <AdapterCard kind="audio" combos={all} />
      {pending?.kind === "edit" && (
        <ComboDialog
          combo={pending.combo}
          combos={all}
          onCancel={() => setPending(null)}
          onSaved={(name) => {
            notify(t("combos.savedNotice", { name }));
            setPending(null);
            setSelected(new Set());
            reload();
          }}
        />
      )}
      {pending?.kind === "delete" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={
            pending.combos.length === 1
              ? t("combos.deleteTitle", { name: pending.combos[0].name })
              : t("combos.deleteManyTitle", { n: String(pending.combos.length) })
          }
          labels={labels.dialog}
          confirmLabel={t("combos.delete")}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={() => void remove(pending.combos)}
        >
          <Stack gap={2}>
            <span>{t("combos.deleteBody")}</span>
            {dialogError && <Banner tone="danger" title={dialogError} />}
          </Stack>
        </Dialog>
      )}
    </Stack>
  );
}

function ComboDialog({
  combo,
  combos,
  onCancel,
  onSaved,
}: {
  combo: Combo | null;
  combos: readonly Combo[];
  onCancel: () => void;
  onSaved: (name: string) => void;
}) {
  const [lang] = useLang();
  const labels = ui(lang);
  const [name, setName] = useState(combo?.name ?? "");
  const [models, setModels] = useState<string[]>(combo?.targets ?? []);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [tried, setTried] = useState(false);
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<StrategyDraft>(() => strategyDraft(combo));
  const set = (patch: Partial<StrategyDraft>) => setDraft({ ...draft, ...patch });
  const body = strategyBody(draft);
  const bad = "bad" in body ? body.bad : null;

  const trimmed = name.trim();
  const nameError = !trimmed ? t("combos.nameRequired") : !COMBO_NAME.test(trimmed) ? t("combos.nameHint") : taken ? t("combos.taken") : null;
  const items = adding ? pickerItems(query, models, combos, combo?.name ?? trimmed) : [];
  const full = models.length >= MAX_MODELS;

  function add(id: string) {
    if (full || models.includes(id)) return;
    setModels([...models, id]);
    setQuery("");
  }

  async function submit() {
    setTried(true);
    if (nameError || "bad" in body) return;
    const { strategy, config } = body;
    setBusy(true);
    setError(null);
    try {
      if (combo) {
        const put = trimmed === combo.name ? { targets: models, strategy, config } : { targets: models, name: trimmed, strategy, config };
        await api(`/combos/${encodeURIComponent(combo.name)}`, { method: "PUT", body: put });
      } else {
        await api("/combos", { method: "POST", body: { name: trimmed, targets: models, strategy, config } });
      }
      onSaved(trimmed);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && e.code === COMBO_TAKEN) setTaken(true);
      else if (e instanceof ApiError && e.status === 400) setError(t("combos.invalid"));
      else if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={combo ? t("combos.editTitle") : t("combos.createTitle")}
      submitLabel={combo ? t("common.save") : t("combos.create")}
      labels={labels.formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field
        label={t("combos.name")}
        hint={t("combos.nameHint")}
        placeholder={t("combos.namePlaceholder")}
        value={name}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setName(e.target.value);
          setTaken(false);
        }}
        error={tried && nameError ? nameError : undefined}
      />
      <div className="combo-models" role="group" aria-labelledby="combo-models-label">
        <span id="combo-models-label" className="settings-label">
          {t("combos.models")}
        </span>
        {models.length === 0 ? (
          <p className="combo-none">{t("combos.noModels")}</p>
        ) : (
          <SortableList
            items={models}
            getKey={(m) => m}
            getLabel={(m) => m}
            label={t("combos.models")}
            labels={labels.sortableList}
            disabled={busy}
            onReorder={(from, to) => setModels(moveItem(models, from, to))}
            renderItem={(m, i, handle) => (
              <div className="combo-row">
                {handle}
                <span className="combo-index">{i + 1}</span>
                <span className="combo-model combo-row-id">{m}</span>
                <IconButton icon="arrow-up" size="sm" label={t("combos.moveUp", { name: m })} disabled={busy || i === 0} onClick={() => setModels(moveItem(models, i, i - 1))} />
                <IconButton
                  icon="arrow-down"
                  size="sm"
                  label={t("combos.moveDown", { name: m })}
                  disabled={busy || i === models.length - 1}
                  onClick={() => setModels(moveItem(models, i, i + 1))}
                />
                <IconButton icon="close" size="sm" label={t("combos.remove", { name: m })} disabled={busy} onClick={() => setModels(models.filter((x) => x !== m))} />
              </div>
            )}
          />
        )}
        {adding ? (
          <SearchPicker
            label={t("combos.pickLabel")}
            placeholder={t("combos.pickPlaceholder")}
            value={query}
            onValueChange={setQuery}
            items={full ? [] : items}
            onPick={add}
            status={full ? t("combos.full", { n: String(MAX_MODELS) }) : items.length === 0 ? t("combos.pickNone") : undefined}
            labels={labels.searchPicker}
          />
        ) : (
          <Button icon="plus" className="combo-add" disabled={busy || full} onClick={() => setAdding(true)}>
            {t("combos.addModel")}
          </Button>
        )}
      </div>
      <Stack gap={2}>
        <label className="settings-label" htmlFor="combo-strategy">
          {t("combos.strategy")}
        </label>
        <Select
          id="combo-strategy"
          aria-describedby="combo-strategy-hint"
          value={draft.strategy}
          disabled={busy}
          options={[{ value: "", label: t("combos.strategy.default") }, ...COMBO_STRATEGIES.map((s) => ({ value: s, label: t(STRATEGY_LABEL[s]) }))]}
          onChange={(e) => set({ strategy: e.target.value as ComboStrategy | "" })}
        />
        <FieldMessage tone="info" id="combo-strategy-hint">
          {draft.strategy ? t(STRATEGY_HINT[draft.strategy]) : t("combos.strategyHint.default")}
        </FieldMessage>
      </Stack>
      {draft.strategy === "smart" && (
        <>
          <Field
            label={t("combos.router")}
            hint={t("combos.routerHint")}
            placeholder={t("combos.modelPlaceholder")}
            value={draft.router}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set({ router: e.target.value })}
            error={tried && bad === "router" ? t("combos.modelBad") : undefined}
          />
          <Stack gap={2}>
            <label className="settings-label" htmlFor="combo-policy">
              {t("combos.policy")}
            </label>
            <Select
              id="combo-policy"
              aria-describedby="combo-policy-hint"
              value={draft.policy}
              disabled={busy}
              options={ROUTER_POLICIES.map((p) => ({ value: p, label: t(POLICY_LABEL[p]) }))}
              onChange={(e) => set({ policy: e.target.value as RouterPolicy })}
            />
            <FieldMessage tone="info" id="combo-policy-hint">
              {t(POLICY_HINT[draft.policy])}
            </FieldMessage>
          </Stack>
          {draft.policy === "custom" && (
            <Field
              label={t("combos.threshold")}
              hint={t("combos.thresholdHint")}
              type="number"
              min={0.5}
              max={0.95}
              step={0.05}
              value={draft.threshold}
              onChange={(e) => set({ threshold: e.target.value })}
              error={tried && bad === "threshold" ? t("combos.thresholdHint") : undefined}
            />
          )}
        </>
      )}
      {draft.strategy === "fusion" && (
        <Field
          label={t("combos.judge")}
          hint={t("combos.judgeHint")}
          placeholder={t("combos.modelPlaceholder")}
          value={draft.judge}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set({ judge: e.target.value })}
          error={tried && bad === "judge" ? t("combos.modelBad") : undefined}
        />
      )}
    </FormDialog>
  );
}

/** The strings that differ between the two adapter rows; the rest are shared (combos.vision.*). */
const ADAPTER_TEXT = {
  vision: {
    title: "combos.vision.title",
    intro: "combos.vision.intro",
    enabled: "combos.vision.enabled",
    enabledHint: "combos.vision.enabledHint",
    modelsHint: "combos.vision.modelsHint",
    save: "combos.vision.save",
    saved: "combos.vision.saved",
  },
  audio: {
    title: "combos.audio.title",
    intro: "combos.audio.intro",
    enabled: "combos.audio.enabled",
    enabledHint: "combos.audio.enabledHint",
    modelsHint: "combos.audio.modelsHint",
    save: "combos.audio.save",
    saved: "combos.audio.saved",
  },
} as const satisfies Record<"vision" | "audio", Record<string, StringKey>>;

/** The Vision and Audio adapter rows, under the combos: the switch saves at once, the two lists with their own Save. */
function AdapterCard({ kind, combos }: { kind: "vision" | "audio"; combos: readonly Combo[] }) {
  const notify = useNotify();
  const text = ADAPTER_TEXT[kind];
  const path = `/${kind}-adapter`;
  const [state, reload] = useLoad<VisionAdapter>(path);
  const [models, setModels] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = state.status === "ready" ? state.data : null;
  // The saved lists fill the editor when they arrive and after a save; copied during render, keyed on the values.
  const savedKey = saved ? JSON.stringify([saved.models, saved.applies_to]) : null;
  const [seen, setSeen] = useState<string | null>(null);
  if (saved && savedKey !== seen) {
    setSeen(savedKey);
    setModels(saved.models);
    setTargets(saved.applies_to);
  }

  async function save(body: Partial<VisionAdapter>) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "PUT", body });
      notify(t(text.saved));
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setError(t("combos.vision.invalid"));
      else if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const ready = saved !== null && saved.models.length > 0 && saved.applies_to.length > 0;
  const changed = saved !== null && visionChanged(saved, models, targets);

  return (
    <Card title={t(text.title)} headingLevel={2}>
      <Stack gap={4}>
        <p className="combo-intro">{t(text.intro)}</p>
        {error && <Banner tone="danger" title={error} />}
        {state.status === "loading" && <Skeleton lines={3} announce labels={{ loading: t("loading") }} />}
        {state.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
        {saved && (
          <>
            <SettingRow
              label={t(text.enabled)}
              description={ready ? t(text.enabledHint) : t("combos.vision.needsLists")}
              controlId={`${kind}-enabled`}
              control={<Switch id={`${kind}-enabled`} checked={saved.enabled} disabled={busy || !ready} onChange={(e) => void save({ enabled: e.target.checked })} />}
            />
            <VisionList
              id={`${kind}-models`}
              label={t("combos.vision.models")}
              hint={t(text.modelsHint)}
              empty={t("combos.vision.noModels")}
              addLabel={t("combos.vision.addModel")}
              pickNone={t("combos.pickNone")}
              items={models}
              max={MAX_ADAPTER_MODELS}
              busy={busy}
              onChange={setModels}
              options={(q) => visionPickerItems(q, models, combos, "pool")}
            />
            <VisionList
              id={`${kind}-targets`}
              label={t("combos.vision.appliesTo")}
              hint={t("combos.vision.appliesHint")}
              empty={t("combos.vision.noTargets")}
              addLabel={t("combos.vision.addTarget")}
              pickNone={t("combos.vision.pickNone")}
              items={targets}
              max={MAX_APPLIES_TO}
              busy={busy}
              onChange={setTargets}
              options={(q) => visionPickerItems(q, targets, combos, "targets")}
            />
            {saved.enabled && (models.length === 0 || targets.length === 0) && <FieldMessage tone="warn">{t("combos.vision.turnsOff")}</FieldMessage>}
            <div>
              <Button disabled={busy || !changed} onClick={() => void save(visionBody(saved, models, targets))}>
                {t(text.save)}
              </Button>
            </div>
          </>
        )}
      </Stack>
    </Card>
  );
}

/** One ordered list of the vision adapter, edited like the combo dialog's model list. */
function VisionList({
  id,
  label,
  hint,
  empty,
  addLabel,
  pickNone,
  items,
  max,
  busy,
  onChange,
  options,
}: {
  id: string;
  label: string;
  hint: string;
  empty: string;
  addLabel: string;
  pickNone: string;
  items: string[];
  max: number;
  busy: boolean;
  onChange: (next: string[]) => void;
  options: (query: string) => SearchPickerItem[];
}) {
  const [lang] = useLang();
  const labels = ui(lang);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const full = items.length >= max;
  const offered = adding && !full ? options(query) : [];
  return (
    <div className="combo-models" role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`}>
      <span id={`${id}-label`} className="settings-label">
        {label}
      </span>
      <FieldMessage tone="info" id={`${id}-hint`}>
        {hint}
      </FieldMessage>
      {items.length === 0 ? (
        <p className="combo-none">{empty}</p>
      ) : (
        <SortableList
          items={items}
          getKey={(m) => m}
          getLabel={(m) => m}
          label={label}
          labels={labels.sortableList}
          disabled={busy}
          onReorder={(from, to) => onChange(moveItem(items, from, to))}
          renderItem={(m, i, handle) => (
            <div className="combo-row">
              {handle}
              <span className="combo-index">{i + 1}</span>
              <span className="combo-model combo-row-id">{m}</span>
              <IconButton icon="arrow-up" size="sm" label={t("combos.moveUp", { name: m })} disabled={busy || i === 0} onClick={() => onChange(moveItem(items, i, i - 1))} />
              <IconButton
                icon="arrow-down"
                size="sm"
                label={t("combos.moveDown", { name: m })}
                disabled={busy || i === items.length - 1}
                onClick={() => onChange(moveItem(items, i, i + 1))}
              />
              <IconButton icon="close" size="sm" label={t("combos.remove", { name: m })} disabled={busy} onClick={() => onChange(items.filter((x) => x !== m))} />
            </div>
          )}
        />
      )}
      {adding ? (
        <SearchPicker
          label={addLabel}
          placeholder={t("combos.pickPlaceholder")}
          value={query}
          onValueChange={setQuery}
          items={offered}
          onPick={(picked) => {
            if (!full && !items.includes(picked)) onChange([...items, picked]);
            setQuery("");
          }}
          status={full ? t("combos.vision.full", { n: String(max) }) : offered.length === 0 ? pickNone : undefined}
          labels={labels.searchPicker}
        />
      ) : (
        <Button icon="plus" className="combo-add" disabled={busy || full} onClick={() => setAdding(true)}>
          {addLabel}
        </Button>
      )}
    </div>
  );
}
