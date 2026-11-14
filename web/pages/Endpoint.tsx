import { BrandMark, EndpointPanel, RouteDiagram } from "@xdev-asia/ui";
import { t, useLang } from "../i18n";
import { ui } from "../ui-labels";

/** The paths the gateway answers under /v1 (worker/app.ts). */
export const V1_PATHS = ["/chat/completions", "/messages", "/models"] as const;

/** The base URL a client sets: this console's own origin, which also serves /v1. */
export function baseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/v1`;
}

/**
 * Top of Endpoint & Key: the base URL to copy, the paths under it, and the route the logo draws:
 * clients in on the left, providers out on the right.
 */
export function EndpointCard() {
  const [lang] = useLang();
  return (
    <EndpointPanel
      title={t("endpoint.title")}
      description={t("endpoint.body")}
      url={baseUrl(window.location.origin)}
      urlLabel={t("endpoint.baseUrl")}
      paths={V1_PATHS.map((p) => `/v1${p}`)}
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
