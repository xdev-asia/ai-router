import { useState } from "react";
import { BrandMark, EndpointPanel, RouteDiagram, Segmented } from "@xdev-asia/ui";
import { t, useLang } from "../i18n";
import { ui } from "../ui-labels";

/** The three API shapes the gateway answers (worker/app.ts). */
export type ApiFormat = "openai" | "anthropic" | "gemini";

export const API_FORMATS: readonly ApiFormat[] = ["openai", "anthropic", "gemini"];

/**
 * The paths each format answers. OpenAI: worker/openai.ts, media.ts, web-tools.ts. Anthropic: worker/proxy.ts.
 * Gemini: worker/gemini.ts (METHODS).
 */
export const API_PATHS: Record<ApiFormat, readonly string[]> = {
  openai: [
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/models",
    "/v1/embeddings",
    "/v1/images/generations",
    "/v1/audio/speech",
    "/v1/audio/transcriptions",
    "/v1/videos",
    "/v1/search",
    "/v1/fetch",
  ],
  anthropic: ["/v1/messages", "/v1/messages/count_tokens"],
  gemini: [
    "/v1beta/models",
    "/v1beta/models/{model}:generateContent",
    "/v1beta/models/{model}:streamGenerateContent",
    "/v1beta/models/{model}:countTokens",
    "/v1beta/models/{model}:embedContent",
  ],
};

/** The variable each format's clients read the base URL from, shown as the label over the URL. */
export const API_ENV: Record<ApiFormat, string> = {
  openai: "OPENAI_BASE_URL",
  anthropic: "ANTHROPIC_BASE_URL",
  gemini: "GOOGLE_GEMINI_BASE_URL",
};

/** The OpenAI base URL: this console's own origin, which also serves /v1. */
export function baseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/v1`;
}

/** The base URL a client of `format` sets. Anthropic and Gemini clients add /v1/... and /v1beta/... themselves. */
export function formatBaseUrl(format: ApiFormat, origin: string): string {
  return format === "openai" ? baseUrl(origin) : origin.replace(/\/+$/, "");
}

/** The API a logged request path went to, by the same routing as worker/app.ts. */
export function apiOf(path: string): ApiFormat {
  if (path.startsWith("/v1beta/")) return "gemini";
  if (path.startsWith("/anthropic/") || path === "/v1/messages" || path.startsWith("/v1/messages/")) return "anthropic";
  return "openai";
}

/**
 * Top of Endpoint & Key: a switch between the three API formats, the base URL to copy and the paths under it,
 * and the route the logo draws: clients in on the left, providers out on the right.
 */
export function EndpointCard() {
  const [lang] = useLang();
  const [format, setFormat] = useState<ApiFormat>("openai");
  return (
    <EndpointPanel
      title={t("endpoint.title")}
      description={t(`endpoint.body.${format}`)}
      actions={
        <Segmented
          label={t("endpoint.format")}
          value={format}
          options={API_FORMATS.map((f) => ({ value: f, label: t(`endpoint.fmt.${f}`) }))}
          onChange={(v) => setFormat(v as ApiFormat)}
        />
      }
      url={formatBaseUrl(format, window.location.origin)}
      urlLabel={API_ENV[format]}
      paths={[...API_PATHS[format]]}
      labels={{ ...ui(lang).codeBlock, paths: t("endpoint.paths") }}
      aside={
        <RouteDiagram
          label={t("endpoint.route")}
          inputs={[
            { id: "agents", label: t("endpoint.in.agents"), icon: "terminal" },
            { id: "apps", label: t("endpoint.in.apps"), icon: "code" },
          ]}
          hub={{ name: t("endpoint.hub"), mark: <BrandMark variant="tile" size={48} /> }}
          outputs={[
            { id: "subscriptions", label: t("endpoint.out.subscriptions"), icon: "accounts" },
            { id: "keys", label: t("endpoint.out.keys"), icon: "key" },
          ]}
        />
      }
    />
  );
}
