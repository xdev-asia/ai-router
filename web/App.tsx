import { useEffect, useState, useSyncExternalStore } from "react";
import { AppShell, BrandMark, Button, NavList, ThemeSwitch } from "@xdev-asia/ui";
import { checkSession, setAuth, signOut, useAuth } from "./api";
import { t, useLang } from "./i18n";
import { LangSelect } from "./LangSelect";
import { NotifyContext, useToasts } from "./notify";
import { SignIn } from "./pages/SignIn";
import { Combos } from "./pages/Combos";
import { ProviderDetail, Providers } from "./pages/Providers";
import { Systems } from "./pages/Systems";
import { TokenSaver } from "./pages/TokenSaver";
import { Usage } from "./pages/Usage";
import { useTheme } from "./theme";
import { ui } from "./ui-labels";

export type Page = "systems" | "providers" | "combos" | "usage" | "token-saver";

/** Hash routes (`#/systems`, `#/providers`, `#/combos`, `#/usage`, `#/token-saver`), so no page path ever collides with the /admin API. */
export function pageFromHash(hash: string): Page {
  if (hash === "#/providers" || hash.startsWith("#/providers/")) return "providers";
  return hash === "#/usage" ? "usage" : hash === "#/token-saver" ? "token-saver" : hash === "#/combos" ? "combos" : "systems";
}

/** The provider of `#/providers/<id>`; null on any other page. */
export function providerFromHash(hash: string): string | null {
  return /^#\/providers\/([a-z][a-z0-9-]{0,31})$/.exec(hash)?.[1] ?? null;
}

function useHash(): string {
  const hash = useSyncExternalStore(
    (l) => {
      window.addEventListener("hashchange", l);
      return () => window.removeEventListener("hashchange", l);
    },
    () => window.location.hash,
    () => "",
  );
  return hash;
}

export function App() {
  const [lang] = useLang();
  const auth = useAuth();
  const [sso, setSso] = useState(false);
  const hash = useHash();
  const page = pageFromHash(hash);
  const provider = providerFromHash(hash);
  const labels = ui(lang);
  const { notify, toasts } = useToasts();
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t("app.name");
  }, [lang]);

  // An xDev ID session (cookie) signs the console in on load; otherwise the sign-in page offers xDev ID
  // when the gateway has it set up, and the admin token.
  useEffect(() => {
    if (auth) return;
    let live = true;
    void checkSession().then((r) => {
      if (!live) return;
      setSso(r.sso);
      if (r.user) setAuth({ kind: "sso", ...r.user });
    });
    return () => {
      live = false;
    };
  }, [auth]);

  if (!auth) return <SignIn sso={sso} />;

  return (
    <NotifyContext.Provider value={notify}>
      <AppShell
        labels={labels.appShell}
        navOpen={navOpen}
        onNavOpenChange={setNavOpen}
        toasts={toasts}
        brand={
          <a className="console-brand" href="#/systems">
            <BrandMark size={20} />
            <span>{t("app.name")}</span>
          </a>
        }
        nav={
          <NavList
            title={t("nav.title")}
            labels={labels.navList}
            value={page}
            onSelect={() => setNavOpen(false)}
            items={[
              { id: "systems", label: t("nav.systems"), icon: "server", href: "#/systems" },
              { id: "providers", label: t("nav.providers"), icon: "plug", href: "#/providers" },
              { id: "combos", label: t("nav.combos"), icon: "list", href: "#/combos" },
              { id: "usage", label: t("nav.usage"), icon: "activity", href: "#/usage" },
              { id: "token-saver", label: t("nav.tokenSaver"), icon: "zap", href: "#/token-saver" },
            ]}
          />
        }
        actions={
          <>
            <ThemeSwitch value={theme} onChange={setTheme} labels={{ group: t("theme.group"), system: t("theme.system"), dark: t("theme.dark"), light: t("theme.light") }} />
            <LangSelect />
            {auth.kind === "sso" && <span className="console-user">{auth.email}</span>}
            <Button icon="sign-out" onClick={() => void signOut()}>
              {t("shell.signOut")}
            </Button>
          </>
        }
      >
        {page === "usage" ? <Usage /> : page === "token-saver" ? <TokenSaver /> : page === "combos" ? <Combos /> : page === "providers" ? provider ? <ProviderDetail key={provider} id={provider} /> : <Providers /> : <Systems />}
      </AppShell>
    </NotifyContext.Provider>
  );
}
