import { useState } from "react";
import { Banner, Button, Card, Combobox, Dialog, EmptyState, Select, Stack, Textarea } from "@xdev-asia/ui";
import { setAuth, useLoad, type System } from "../api";
import { t, useLang } from "../i18n";
import { ui } from "../ui-labels";

/** One image the gateway answered: a data URL made from `b64_json`, or the provider's URL as it came. */
export interface DrawnImage {
  id: string;
  src: string;
  prompt: string;
  model: string;
  size: string;
  at: number;
}

export const SIZES = ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024", "512x512"] as const;

/** Models offered in the picker: OpenAI's own, then each media provider's image models. Any other can be typed. */
export function imageModelOptions(mediaProviders: { id: string; name: string; models: Record<string, string[]> }[]): { value: string; label: string; meta: string }[] {
  const out = ["gpt-image-1", "dall-e-3"].map((m) => ({ value: `openai/${m}`, label: `openai/${m}`, meta: "" }));
  for (const p of mediaProviders) for (const m of p.models.images ?? []) out.push({ value: `${p.id}/${m}`, label: `${p.id}/${m}`, meta: p.name });
  return out;
}

/** The images in an OpenAI images answer, as `src` values an image element can show. */
export function imagesOf(body: unknown): string[] {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(data)) return [];
  return data.flatMap((d: unknown) => {
    if (!d || typeof d !== "object") return [];
    const { b64_json, url } = d as { b64_json?: unknown; url?: unknown };
    if (typeof b64_json === "string" && b64_json) return [`data:image/png;base64,${b64_json}`];
    if (typeof url === "string" && /^https:\/\//.test(url)) return [url];
    return [];
  });
}

async function failure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } | string } | null;
  const e = body?.error;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  return t("error.generic");
}

/**
 * Draws images from the console as one of the owner's systems (POST /admin/images/generations), so its allowed
 * models and cap apply and the usage lands on it. The images stay in this page only: nothing is stored.
 */
export function ImagePlayground({ mediaProviders }: { mediaProviders: { id: string; name: string; models: Record<string, string[]> }[] }) {
  const [lang] = useLang();
  const [systems] = useLoad<System[]>("/systems");
  const usable = systems.status === "ready" ? systems.data.filter((s) => !s.disabled) : [];
  const [systemId, setSystemId] = useState<string | null>(null);
  const system = usable.find((s) => s.id === systemId)?.id ?? usable[0]?.id ?? null;
  const [options, setOptions] = useState(() => imageModelOptions(mediaProviders));
  const [model, setModel] = useState<string | null>("openai/gpt-image-1");
  const [size, setSize] = useState<string>(SIZES[0]);
  const [n, setN] = useState("1");
  const [prompt, setPrompt] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<DrawnImage[]>([]);
  const [open, setOpen] = useState<DrawnImage | null>(null);

  async function draw() {
    if (!prompt.trim()) {
      setPromptError(t("imgplay.promptRequired"));
      return;
    }
    if (!system || !model) return;
    setPromptError(null);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/admin/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system, model, prompt: prompt.trim(), size, n: Number(n) }),
      });
      if (res.status === 401) {
        setAuth(null);
        return;
      }
      if (!res.ok) {
        setError(await failure(res));
        return;
      }
      const got = imagesOf(await res.json().catch(() => null));
      if (!got.length) {
        setError(t("imgplay.noImage"));
        return;
      }
      const at = Date.now();
      setImages((prev) => [...got.map((src, i) => ({ id: `${at}-${i}`, src, prompt: prompt.trim(), model, size, at })), ...prev]);
    } catch {
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("imgplay.title")} subtitle={t("imgplay.subtitle")} headingLevel={2}>
      <Stack gap={4}>
        {systems.status === "ready" && usable.length === 0 ? (
          <EmptyState size="inline" icon="plug" title={t("imgplay.noSystem")} actions={<Button href="#/systems">{t("imgplay.addSystem")}</Button>} />
        ) : (
          <form
            className="imgplay-form"
            onSubmit={(e) => {
              e.preventDefault();
              void draw();
            }}
          >
            <div className="imgplay-row">
              <Select label={t("imgplay.system")} value={system ?? ""} onChange={(e) => setSystemId(e.target.value)} options={usable.map((s) => ({ value: s.id, label: s.name }))} />
              <Combobox
                label={t("imgplay.model")}
                options={options}
                value={model}
                onChange={setModel}
                onCreate={(text) => {
                  const v = text.trim();
                  setOptions((o) => [...o, { value: v, label: v, meta: "" }]);
                  setModel(v);
                }}
                labels={ui(lang).combobox}
              />
              <Select label={t("imgplay.size")} value={size} onChange={(e) => setSize(e.target.value)} options={SIZES.map((s) => ({ value: s, label: s }))} />
              <Select label={t("imgplay.count")} value={n} onChange={(e) => setN(e.target.value)} options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))} />
            </div>
            <Textarea
              label={t("imgplay.prompt")}
              placeholder={t("imgplay.promptPlaceholder")}
              rows={3}
              value={prompt}
              error={promptError ?? undefined}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (promptError && e.target.value.trim()) setPromptError(null);
              }}
            />
            <div className="imgplay-actions">
              <Button type="submit" variant="primary" icon="image" disabled={busy || !system || !model}>
                {busy ? t("imgplay.drawing") : t("imgplay.draw")}
              </Button>
              {images.length > 0 && (
                <Button variant="ghost" icon="trash" onClick={() => setImages([])} disabled={busy}>
                  {t("imgplay.clear")}
                </Button>
              )}
            </div>
          </form>
        )}
        {error && <Banner tone="danger" title={error} />}
        {images.length > 0 ? (
          <ul className="imgplay-grid" aria-label={t("imgplay.results")}>
            {images.map((im) => (
              <li key={im.id} className="imgplay-item">
                <button type="button" className="imgplay-thumb" onClick={() => setOpen(im)} aria-label={t("imgplay.view", { prompt: im.prompt })}>
                  <img src={im.src} alt={im.prompt} loading="lazy" />
                </button>
                <div className="imgplay-meta">
                  <span className="imgplay-prompt" title={im.prompt}>
                    {im.prompt}
                  </span>
                  <span className="muted">
                    {im.model} · {im.size}
                  </span>
                </div>
                <Button variant="ghost" size="sm" icon="download" href={im.src} download={`image-${im.id}.png`} target="_blank" rel="noreferrer noopener" aria-label={t("imgplay.download")} />
              </li>
            ))}
          </ul>
        ) : (
          !busy && <p className="muted">{t("imgplay.empty")}</p>
        )}
        {open && (
          <Dialog
            modal
            size="wide"
            title={open.model}
            description={open.prompt}
            body="plain"
            dismissible
            onCancel={() => setOpen(null)}
            labels={ui(lang).dialog}
            actions={
              <Button icon="download" href={open.src} download={`image-${open.id}.png`} target="_blank" rel="noreferrer noopener">
                {t("imgplay.download")}
              </Button>
            }
          >
            <img className="imgplay-full" src={open.src} alt={open.prompt} />
          </Dialog>
        )}
      </Stack>
    </Card>
  );
}
