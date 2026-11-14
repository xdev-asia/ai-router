import { useState } from "react";
import { Banner, Button, Card, CodeBlock, Field, Grid, Segmented, Stack, Textarea } from "@xdev-asia/ui";
import { ApiError, api } from "../api";
import { t, useLang, type StringKey } from "../i18n";
import { ui } from "../ui-labels";

/** The formats POST /admin/translate takes and gives (worker/translator.ts). */
export const SOURCES = ["openai", "responses", "gemini"] as const;
export const TARGETS = ["openai", "anthropic"] as const;
export type Source = (typeof SOURCES)[number];
export type Target = (typeof TARGETS)[number];

const LABEL: Record<Source | Target, StringKey> = {
  openai: "translator.format.openai",
  responses: "translator.format.responses",
  gemini: "translator.format.gemini",
  anthropic: "translator.format.anthropic",
};

/** A small request in each source format, to start from. */
export const EXAMPLES: Record<Source, object> = {
  openai: { model: "anthropic/claude-sonnet-4-5", max_tokens: 256, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hello" }] },
  responses: { model: "openai/gpt-5", instructions: "Be brief.", input: "Hello", max_output_tokens: 256 },
  gemini: { systemInstruction: { parts: [{ text: "Be brief." }] }, contents: [{ role: "user", parts: [{ text: "Hello" }] }], generationConfig: { maxOutputTokens: 256 } },
};

const example = (s: Source) => JSON.stringify(EXAMPLES[s], null, 2);

/** The JSON object in `text`, or null when it is not one. */
export function parseBody(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Translator: paste a request in one format and see the request the gateway sends to a provider
 * that speaks another, using the same code as the routes. Nothing is sent upstream.
 */
export function Translator() {
  const [lang] = useLang();
  const [from, setFrom] = useState<Source>("responses");
  const [to, setTo] = useState<Target>("anthropic");
  const [text, setText] = useState(() => example("responses"));
  const [model, setModel] = useState("anthropic/claude-sonnet-4-5");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [badJson, setBadJson] = useState(false);
  const [busy, setBusy] = useState(false);

  const targets = TARGETS.filter((x) => x !== from);
  const target: Target = targets.includes(to) ? to : targets[0]!;

  function pickFrom(next: Source) {
    // Swap in that format's example while the box still holds the previous one.
    if (text.trim() === example(from)) setText(example(next));
    setFrom(next);
    setResult(null);
    setError(null);
  }

  async function translate() {
    const body = parseBody(text);
    setBadJson(body === null);
    setError(null);
    setResult(null);
    if (!body) return;
    setBusy(true);
    try {
      const r = await api<{ result: unknown }>("/translate", { body: { from, to: target, body, ...(from === "gemini" ? { model: model.trim() } : {}) } });
      setResult(JSON.stringify(r.result, null, 2));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.detail ? e.detail : t(e instanceof ApiError && e.code === "invalid_input" ? "translator.invalid" : "error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const options = (list: readonly (Source | Target)[]) => list.map((v) => ({ value: v, label: t(LABEL[v]) }));

  return (
    <Grid columns={{ base: 1, lg: 2 }} gap={4}>
      <Card title={t("translator.request")} subtitle={t("translator.requestHint")} headingLevel={2}>
        <Stack gap={3}>
          <Stack gap={1}>
            <span className="muted">{t("translator.from")}</span>
            <Segmented label={t("translator.from")} options={options(SOURCES)} value={from} onChange={(v) => pickFrom(v as Source)} />
          </Stack>
          <Stack gap={1}>
            <span className="muted">{t("translator.to")}</span>
            <Segmented label={t("translator.to")} options={options(targets)} value={target} onChange={(v) => setTo(v as Target)} />
          </Stack>
          {from === "gemini" && (
            <Field label={t("translator.model")} hint={t("translator.modelHint")} value={model} maxLength={200} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
          )}
          <Textarea
            label={t("translator.body")}
            mono
            rows={14}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            error={badJson ? t("translator.badJson") : undefined}
          />
          <div className="translator-actions">
            <Button variant="ghost" onClick={() => setText(example(from))}>
              {t("translator.example")}
            </Button>
            <Button variant="primary" disabled={busy || (from === "gemini" && model.trim() === "")} onClick={() => void translate()}>
              {t("translator.run")}
            </Button>
          </div>
        </Stack>
      </Card>
      <Card title={t("translator.result")} subtitle={t("translator.resultHint", { format: t(LABEL[target]) })} headingLevel={2}>
        {error ? (
          <Banner tone="danger" title={t("translator.failed")}>
            {error}
          </Banner>
        ) : result ? (
          <CodeBlock code={result} language="json" labels={ui(lang).codeBlock} />
        ) : (
          <span className="muted">{t("translator.empty")}</span>
        )}
      </Card>
    </Grid>
  );
}
