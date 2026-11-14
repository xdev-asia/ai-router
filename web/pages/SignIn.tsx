import { useState } from "react";
import { Banner, BrandMark, Button, Card, Field, Stack } from "@xdev-asia/ui";
import { ApiError, signInWithToken } from "../api";
import { t } from "../i18n";
import { LangSelect } from "../LangSelect";

const SIGNIN_ERRORS = ["not_allowed", "expired", "cancelled", "failed", "not_configured"] as const;
type SigninError = (typeof SIGNIN_ERRORS)[number];

/** The `?signin_error=` the gateway sends back after a failed xDev ID sign-in. */
export function signinError(search: string): SigninError | null {
  const code = new URLSearchParams(search).get("signin_error");
  return (SIGNIN_ERRORS as readonly string[]).includes(code ?? "") ? (code as SigninError) : null;
}

/**
 * xDev ID first (when the gateway has it set up), then the admin token as a fallback.
 * The pasted token is traded for a session cookie (POST /auth/token); the page does not keep it.
 */
export function SignIn({ sso }: { sso: boolean }) {
  const ssoError = signinError(window.location.search);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const candidate = value.trim();
    try {
      await signInWithToken(candidate);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? t("signin.wrong") : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <div className="signin-pane">
        <Stack gap={4} className="signin-box">
          <Stack direction="row" justify="between" align="center">
            <span className="console-brand">
              <BrandMark variant="tile" size={36} />
              <span className="console-brand-name">{t("app.name")}</span>
            </span>
            <LangSelect />
          </Stack>
          <h1 className="x-sr-only">{t("app.name")}</h1>
          {ssoError && <Banner tone="danger" title={t(`signin.error.${ssoError}`)} />}
          {sso && (
            <Card title={t("signin.title")} headingLevel={2}>
              <Stack gap={3}>
                <p className="muted">{t("signin.ssoBody")}</p>
                <Button variant="primary" onClick={() => window.location.assign("/auth/login")}>
                  {t("signin.sso")}
                </Button>
              </Stack>
            </Card>
          )}
          <Card title={sso ? t("signin.tokenTitle") : t("signin.title")} headingLevel={2}>
            <form
              className="signin-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <p className="muted">{t("signin.body")}</p>
              <Field
                label={t("signin.token")}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                error={error ?? undefined}
              />
              <Button type="submit" variant={sso ? "secondary" : "primary"} disabled={busy || value.trim() === ""}>
                {t("signin.submit")}
              </Button>
            </form>
          </Card>
        </Stack>
      </div>
      {/* The route of the logo, drawn large; decoration only, hidden on narrow screens. */}
      <div className="signin-art" aria-hidden="true">
        <img src="/signin-hero.svg" alt="" />
      </div>
    </main>
  );
}
