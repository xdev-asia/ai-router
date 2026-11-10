import { useEffect, useState, useSyncExternalStore } from "react";
import { AppShell, BrandMark, Button, NavList } from "@xdev-asia/ui";
import { setToken, useToken } from "./api";
import { t, useLang } from "./i18n";
import { LangSelect } from "./LangSelect";
import { NotifyContext, useToasts } from "./notify";
import { SignIn } from "./pages/SignIn";
import { Systems } from "./pages/Systems";
import { Usage } from "./pages/Usage";
import { ui } from "./ui-labels";

export type Page = "systems" | "usage";

/** Hash routes (`#/systems`, `#/usage`), so no page path ever collides with the /admin API. */
export function pageFromHash(hash: string): Page {
  return hash === "#/usage" ? "usage" : "systems";
}

function usePage(): Page {
  const hash = useSyncExternalStore(
    (l) => {
      window.addEventListener("hashchange", l);
      return () => window.removeEventListener("hashchange", l);
    },
    () => window.location.hash,
    () => "",
  );
  return pageFromHash(hash);
}

export function App() {
  const [lang] = useLang();
  const token = useToken();
  const page = usePage();
  const labels = ui(lang);
  const { notify, toasts } = useToasts();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t("app.name");
  }, [lang]);

  if (!token) return <SignIn />;

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
              { id: "usage", label: t("nav.usage"), icon: "activity", href: "#/usage" },
            ]}
          />
        }
        actions={
          <>
            <LangSelect />
            <Button icon="sign-out" onClick={() => setToken(null)}>
              {t("shell.signOut")}
            </Button>
          </>
        }
      >
        {page === "usage" ? <Usage /> : <Systems />}
      </AppShell>
    </NotifyContext.Provider>
  );
}
