import { useState } from "react";
import { BrandMark, Button, Card, Field, Stack } from "@xdev-asia/ui";
import { ApiError, api, setToken } from "../api";
import { t } from "../i18n";
import { LangSelect } from "../LangSelect";

/** Checks the pasted token against /admin/systems before keeping it. */
export function SignIn() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const candidate = value.trim();
    try {
      await api("/systems", { token: candidate });
      setToken(candidate);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? t("signin.wrong") : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <Stack gap={4} className="signin-box">
        <Stack direction="row" justify="between" align="center">
          <span className="console-brand">
            <BrandMark size={20} />
            <span>{t("app.name")}</span>
          </span>
          <LangSelect />
        </Stack>
        <h1 className="x-sr-only">{t("app.name")}</h1>
        <Card title={t("signin.title")} headingLevel={2}>
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
            <Button type="submit" variant="primary" disabled={busy || value.trim() === ""}>
              {t("signin.submit")}
            </Button>
          </form>
        </Card>
      </Stack>
    </main>
  );
}
