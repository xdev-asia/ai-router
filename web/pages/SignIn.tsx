import { useState } from "react";
import { AuthShell, Banner, BrandMark, Button, Field, Stack, ThemeSwitch } from "@xdev-asia/ui";
import { ApiError, signInWithToken } from "../api";
import { t } from "../i18n";
import { LangSelect } from "../LangSelect";
import { useTheme } from "../theme";

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
  const [theme, setTheme, shownTheme] = useTheme();
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
    <AuthShell
      brand={
        <>
          <BrandMark variant="tile" size={32} />
          <span>{t("app.name")}</span>
        </>
      }
      actions={
        <>
          <LangSelect />
          <ThemeSwitch variant="icon" value={theme} resolved={shownTheme} onChange={setTheme} labels={{ toDark: t("theme.toDark"), toLight: t("theme.toLight") }} />
        </>
      }
      headline={t("signin.headline")}
      tagline={t("signin.tagline")}
      footer={t("signin.footer", { year: String(new Date().getFullYear()) })}
    >
      <Stack gap={4}>
        <Stack gap={1}>
          <h1>{t("signin.welcome")}</h1>
          <p className="muted">{sso ? t("signin.ssoBody") : t("signin.title")}</p>
        </Stack>
        {ssoError && <Banner tone="danger" title={t(`signin.error.${ssoError}`)} />}
        {sso && (
          <>
            <Button variant="primary" onClick={() => window.location.assign("/auth/login")}>
              {t("signin.sso")}
            </Button>
            <p className="signin-or">{t("signin.tokenTitle")}</p>
          </>
        )}
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
      </Stack>
    </AuthShell>
  );
}
