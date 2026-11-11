import { useState } from "react";
import { Checkbox, FormDialog, Select, Stack, Textarea } from "@xdev-asia/ui";
import { ApiError, MODEL_PATTERN, api, patternsOf, splitList, type SaverLevel, type System } from "../api";
import { t, useLang } from "../i18n";
import { ui } from "../ui-labels";

const LEVELS: (SaverLevel | "")[] = ["", "lite", "full", "ultra"];

/** Models a system may call, and its token savers. Saved together with one PATCH. */
export function SystemSettings({ system, onCancel, onSaved }: { system: System; onCancel: () => void; onSaved: () => void }) {
  const [lang] = useLang();
  const [models, setModels] = useState(patternsOf(system).join("\n"));
  const [rtk, setRtk] = useState(system.rtk);
  const [caveman, setCaveman] = useState<SaverLevel | "">(system.caveman ?? "");
  const [ponytail, setPonytail] = useState<SaverLevel | "">(system.ponytail ?? "");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = splitList(models);
  const bad = list.filter((p) => !MODEL_PATTERN.test(p));
  const modelsOk = list.length > 0 && list.length <= 50 && bad.length === 0;
  const levelOptions = LEVELS.map((v) => ({ value: v, label: v === "" ? t("settings.off") : t(`settings.level.${v}`) }));

  async function submit() {
    setTried(true);
    if (!modelsOk) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/systems/${encodeURIComponent(system.id)}`, {
        method: "PATCH",
        body: { allowed_models: list, rtk, caveman: caveman || null, ponytail: ponytail || null },
      });
      onSaved();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      title={t("settings.title", { id: system.id })}
      description={t("settings.description")}
      submitLabel={t("common.save")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Textarea
        label={t("settings.models")}
        hint={t("settings.modelsHint")}
        mono
        rows={5}
        spellCheck={false}
        value={models}
        onChange={(e) => setModels(e.target.value)}
        error={tried && !modelsOk ? (bad.length ? t("settings.modelsBad", { bad: bad.join(", ") }) : t("settings.modelsHint")) : undefined}
      />
      <h3 className="dialog-subheading">{t("settings.savers")}</h3>
      <p className="muted">{t("settings.saversHint")}</p>
      <Checkbox label={t("settings.rtk")} hint={t("settings.rtkHint")} checked={rtk} onChange={(e) => setRtk(e.target.checked)} />
      <Stack gap={2}>
        <label className="settings-label" htmlFor="saver-caveman">
          {t("settings.caveman")}
        </label>
        <Select id="saver-caveman" value={caveman} options={levelOptions} onChange={(e) => setCaveman(e.target.value as SaverLevel | "")} />
        <span className="muted">{t("settings.cavemanHint")}</span>
      </Stack>
      <Stack gap={2}>
        <label className="settings-label" htmlFor="saver-ponytail">
          {t("settings.ponytail")}
        </label>
        <Select id="saver-ponytail" value={ponytail} options={levelOptions} onChange={(e) => setPonytail(e.target.value as SaverLevel | "")} />
        <span className="muted">{t("settings.ponytailHint")}</span>
      </Stack>
    </FormDialog>
  );
}
