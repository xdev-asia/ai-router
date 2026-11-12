import { useEffect, useState } from "react";
import { Banner, Button, Card, Field, PageHeader, Select, SettingRow, Skeleton, Stack, Switch, Textarea } from "@xdev-asia/ui";
import { ApiError, api, useLoad, type SaverLevel, type TokenSaverSettings } from "../api";
import { t, useLang } from "../i18n";
import { useNotify } from "../notify";

const isWebAddress = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * Token saver, laid out as 9router's page: one row per saver. Switches and levels save at once; the Headroom
 * address and the custom prompt are typed first and saved with their own button.
 */
export function TokenSaver() {
  useLang();
  const notify = useNotify();
  const [settings, reload] = useLoad<TokenSaverSettings>("/token-saver");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState(false);
  const [prompt, setPrompt] = useState("");

  const data = settings.status === "ready" ? settings.data : null;
  // The saved values fill the two text fields when they arrive, and again after each save.
  useEffect(() => {
    if (!data) return;
    setUrl(data.headroom.url ?? "");
    setPrompt(data.custom_prompt ?? "");
  }, [data]);

  async function save(patch: Partial<TokenSaverSettings>) {
    setBusy(true);
    setError(null);
    try {
      await api("/token-saver", { method: "PUT", body: patch });
      notify(t("saver.saved"));
      reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const levels = [
    { value: "", label: t("settings.off") },
    { value: "lite", label: t("settings.level.lite") },
    { value: "full", label: t("settings.level.full") },
    { value: "ultra", label: t("settings.level.ultra") },
  ];
  const level = (v: string): SaverLevel | null => (v === "" ? null : (v as SaverLevel));

  function saveHeadroomUrl() {
    const address = url.trim();
    if (address !== "" && !isWebAddress(address)) {
      setUrlError(true);
      return;
    }
    setUrlError(false);
    // Without an address Headroom cannot stay on.
    void save({ headroom: { enabled: address === "" ? false : (data?.headroom.enabled ?? false), url: address === "" ? null : address } });
  }

  return (
    <Stack gap={4}>
      <PageHeader title={t("saver.title")} description={t("saver.description")} />
      {error && <Banner tone="danger" title={error} />}
      {settings.status === "loading" && <Skeleton lines={4} announce labels={{ loading: t("loading") }} />}
      {settings.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
      {data && (
        <>
          <Card title={t("saver.card")} headingLevel={2}>
            <Stack gap={3}>
              <SettingRow
                label={t("saver.rtk")}
                description={t("saver.rtkHint")}
                controlId="saver-rtk"
                control={<Switch id="saver-rtk" checked={data.rtk} disabled={busy} onChange={(e) => void save({ rtk: e.target.checked })} />}
              />
              <SettingRow
                label={t("saver.headroom")}
                description={t("saver.headroomHint")}
                controlId="saver-headroom"
                control={
                  <Switch
                    id="saver-headroom"
                    checked={data.headroom.enabled}
                    disabled={busy || data.headroom.url === null}
                    onChange={(e) => void save({ headroom: { enabled: e.target.checked, url: data.headroom.url } })}
                  />
                }
              />
              <div className="saver-inline">
                <Field
                  label={t("saver.headroomUrl")}
                  hint={t("saver.headroomUrlHint")}
                  type="url"
                  value={url}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setUrl(e.target.value)}
                  error={urlError ? t("saver.headroomUrlBad") : undefined}
                />
                <Button disabled={busy} onClick={saveHeadroomUrl}>
                  {t("saver.saveHeadroom")}
                </Button>
              </div>
              <SettingRow
                label={t("saver.caveman")}
                description={t("saver.cavemanHint")}
                controlId="saver-caveman"
                control={<Select id="saver-caveman" value={data.caveman ?? ""} options={levels} disabled={busy} onChange={(e) => void save({ caveman: level(e.target.value) })} />}
              />
              <SettingRow
                label={t("saver.ponytail")}
                description={t("saver.ponytailHint")}
                controlId="saver-ponytail"
                control={<Select id="saver-ponytail" value={data.ponytail ?? ""} options={levels} disabled={busy} onChange={(e) => void save({ ponytail: level(e.target.value) })} />}
              />
            </Stack>
          </Card>
          <Card>
            <Stack gap={3}>
              <Textarea label={t("saver.custom")} hint={t("saver.customHint")} rows={5} maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              <div>
                <Button disabled={busy} onClick={() => void save({ custom_prompt: prompt.trim() === "" ? null : prompt.trim() })}>
                  {t("saver.saveCustom")}
                </Button>
              </div>
            </Stack>
          </Card>
        </>
      )}
    </Stack>
  );
}
