import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppShell, Banner, BrandMark, Button, Container, MenuButton, NavList, PaletteTrigger, SearchInput, ServiceStatus, ShellTitle, ThemeSwitch, type IconName } from "@xdev-asia/ui";
import { checkSession, setAuth, signOut, useAuth, useLoad, type Auth, type Combo, type Connection } from "./api";
import { t, useLang, type StringKey } from "./i18n";
import { LangSelect } from "./LangSelect";
import { NotifyContext, useToasts } from "./notify";
import { ConsolePalette } from "./palette";
import { SignIn } from "./pages/SignIn";
import { Combos } from "./pages/Combos";
import { ProviderDetail, Providers } from "./pages/Providers";
import { Systems } from "./pages/Systems";
import { TokenSaver } from "./pages/TokenSaver";
import { Quota } from "./pages/Quota";
import { Usage } from "./pages/Usage";
import { CliTools } from "./pages/CliTools";
import { Logs } from "./pages/Logs";
import { Media } from "./pages/Media";
import { ProxyPools } from "./pages/ProxyPools";
import { Settings } from "./pages/Settings";
import { Pricing } from "./pages/Pricing";
import { Skills } from "./pages/Skills";
import { Translator } from "./pages/Translator";
import { BasicChat } from "./pages/BasicChat";
import { ShellTitleContext } from "./shell";
import { useTheme } from "./theme";
import { useTranslatorShown } from "./translator-pref";
import { ui } from "./ui-labels";
import { BUILD, buildLabel, useNewBuild } from "./version";

export type Page = "systems" | "providers" | "combos" | "cli-tools" | "usage" | "quota" | "token-saver" | "media" | "proxy-pools" | "skills" | "logs" | "translator" | "chat" | "settings" | "pricing";

/** Sidebar order, icons and the strings of each page's title in the top bar. */
const PAGES: { id: Page; nav: StringKey; title: StringKey; description: StringKey; icon: IconName }[] = [
  { id: "systems", nav: "nav.systems", title: "systems.title", description: "systems.description", icon: "key" },
  { id: "providers", nav: "nav.providers", title: "providers.title", description: "providers.description", icon: "plug" },
  { id: "combos", nav: "nav.combos", title: "combos.title", description: "combos.description", icon: "layers" },
  { id: "cli-tools", nav: "nav.cliTools", title: "cli.title", description: "cli.description", icon: "terminal" },
  { id: "usage", nav: "nav.usage", title: "usage.title", description: "usage.description", icon: "activity" },
  { id: "quota", nav: "nav.quota", title: "quota.title", description: "quota.description", icon: "clock" },
  { id: "token-saver", nav: "nav.tokenSaver", title: "saver.title", description: "saver.description", icon: "zap" },
  { id: "media", nav: "nav.media", title: "media.title", description: "media.description", icon: "image" },
  { id: "proxy-pools", nav: "nav.proxyPools", title: "pools.title", description: "pools.description", icon: "server" },
  { id: "skills", nav: "nav.skills", title: "skills.title", description: "skills.description", icon: "book" },
  { id: "logs", nav: "nav.logs", title: "logs.title", description: "logs.description", icon: "list" },
  { id: "translator", nav: "nav.translator", title: "translator.title", description: "translator.description", icon: "swap" },
  { id: "chat", nav: "nav.chat", title: "chat.title", description: "chat.description", icon: "chat" },
  { id: "settings", nav: "nav.settings", title: "prefs.title", description: "prefs.description", icon: "settings" },
  { id: "pricing", nav: "nav.pricing", title: "pricing.title", description: "pricing.description", icon: "tag" },
];

/** The sidebar's three groups: what the gateway routes, what it reports, and the gateway itself. */
const GROUPS: { title: StringKey; pages: Page[] }[] = [
  { title: "nav.title", pages: ["systems", "providers", "combos", "cli-tools"] },
  { title: "nav.insight", pages: ["usage", "quota", "token-saver"] },
  { title: "nav.system", pages: ["media", "proxy-pools", "skills", "logs", "translator", "settings", "pricing"] },
];

/** Hash routes (`#/<page>`, `#/providers/<id>`, `#/media/<tab>`), so no page path ever collides with the /admin API. */
export function pageFromHash(hash: string): Page {
  if (hash === "#/providers" || hash.startsWith("#/providers/")) return "providers";
  if (hash === "#/media" || hash.startsWith("#/media/")) return "media";
  if (hash.startsWith("#/cli-tools/")) return "cli-tools";
  const id = hash.slice(2);
  return PAGES.some((p) => p.id === id) ? (id as Page) : "systems";
}

/** The provider of `#/providers/<id>`; null on any other page. */
export function providerFromHash(hash: string): string | null {
  return /^#\/providers\/([a-z][a-z0-9-]{0,31})$/.exec(hash)?.[1] ?? null;
}

/** The tool of `#/cli-tools/<id>`; null on any other page. */
export function cliToolFromHash(hash: string): string | null {
  return /^#\/cli-tools\/([a-z][a-z0-9-]{0,31})$/.exec(hash)?.[1] ?? null;
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

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t("app.name");
  }, [lang]);

  // A console session (cookie, from xDev ID or the admin token) signs the console in on load; otherwise the
  // sign-in page offers xDev ID when the gateway has it set up, and the admin token.
  useEffect(() => {
    if (auth) return;
    let live = true;
    void checkSession().then((r) => {
      if (!live) return;
      setSso(r.sso);
      if (r.user) setAuth(r.user);
    });
    return () => {
      live = false;
    };
  }, [auth]);

  return auth ? <Console auth={auth} /> : <SignIn sso={sso} />;
}

/**
 * What the sidebar shows beside a page's name: how many there are, and a dot when one needs a look.
 * Fetched again on every page change, so a combo or account added on its page shows up when you move on.
 */
function useNavStats(page: Page): Partial<Record<Page, { count?: number; tone?: "warn"; toneLabel?: string }>> {
  const [combos, reloadCombos] = useLoad<Combo[]>("/combos");
  const [connections, reloadConnections] = useLoad<Connection[]>("/connections");
  useEffect(() => {
    reloadCombos();
    reloadConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on page change only
  }, [page]);
  const now = Date.now() / 1000;
  const cooling = connections.status === "ready" ? connections.data.filter((c) => !c.disabled && c.cooldown_until > now).length : 0;
  return {
    combos: combos.status === "ready" ? { count: combos.data.length } : undefined,
    providers:
      connections.status === "ready"
        ? { count: connections.data.length, ...(cooling ? { tone: "warn" as const, toneLabel: t("nav.cooling", { n: String(cooling) }) } : {}) }
        : undefined,
  };
}

function Console({ auth }: { auth: NonNullable<Auth> }) {
  const [lang] = useLang();
  const hash = useHash();
  const page = pageFromHash(hash);
  const provider = providerFromHash(hash);
  const labels = ui(lang);
  const { notify, toasts } = useToasts();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme, shownTheme] = useTheme();
  const [translatorShown] = useTranslatorShown();
  const [pageTitle, setPageTitle] = useState<ReactNode | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const stats = useNavStats(page);
  const newBuild = useNewBuild();

  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];
  const title = pageTitle ?? <ShellTitle icon={current.icon} title={t(current.title)} description={t(current.description)} />;
  const themes = ["system", "dark", "light"] as const;

  return (
    <NotifyContext.Provider value={notify}>
      <ShellTitleContext.Provider value={setPageTitle}>
        <AppShell
          labels={labels.appShell}
          navOpen={navOpen}
          onNavOpenChange={setNavOpen}
          drawerBelow="lg"
          toasts={toasts}
          brand={
            <a className="console-brand" href="#/systems">
              {/* A 36 px app tile, the name, what it is under it; the version moves to the sidebar foot. */}
              <BrandMark variant="tile" size={36} />
              <span className="console-brand-text">
                <span className="console-brand-name">{t("app.name")}</span>
                <span className="console-brand-tagline">{t("app.tagline")}</span>
              </span>
            </a>
          }
          nav={[
            <PaletteTrigger key="palette" className="console-palette" onOpen={() => setPaletteOpen(true)} labels={{ search: t("palette.trigger") }} />,
            ...GROUPS.map((g) => (
            <NavList
              key={g.title}
              title={t(g.title)}
              labels={{ ...labels.navList, nav: t(g.title) }}
              value={page}
              onSelect={() => setNavOpen(false)}
              items={PAGES.filter((p) => g.pages.includes(p.id) && (p.id !== "translator" || translatorShown)).map((p) => ({ id: p.id, label: t(p.nav), icon: p.icon, href: `#/${p.id}`, ...stats[p.id] }))}
            />
          )),
          ]}
          navFooter={<ServiceStatus tone="ok" label={t("shell.online")} detail={buildLabel(BUILD)} />}
          title={title}
          actions={
            <>
              {page === "providers" && !provider && (
                <SearchInput
                  size="md"
                  className="console-search"
                  aria-label={t("providers.search")}
                  placeholder={t("providers.searchPlaceholder")}
                  value={providerQuery}
                  onChange={(e) => setProviderQuery(e.target.value)}
                  onClear={() => setProviderQuery("")}
                />
              )}
              <ThemeSwitch variant="icon" value={theme} resolved={shownTheme} onChange={setTheme} labels={{ toDark: t("theme.toDark"), toLight: t("theme.toLight") }} />
              <LangSelect />
              {auth.kind === "sso" && <span className="console-user">{auth.email}</span>}
              <MenuButton
                variant="icon"
                icon="more"
                align="end"
                label={t("shell.account")}
                items={[
                  { type: "group", label: t("theme.group") },
                  ...themes.map((v) => ({ label: t(`theme.${v}`), checked: theme === v, onSelect: () => setTheme(v) })),
                  { type: "separator" },
                  { label: t("shell.signOut"), onSelect: () => void signOut() },
                ]}
              />
            </>
          }
        >
          {/* One width for every page (1280px at most), as the xdev-ui admin layout asks; the shell already pads. */}
          <Container size="xl" gutter={false}>
            {newBuild && (
              <div className="console-new-build">
                <Banner
                  tone="info"
                  title={t("build.newTitle")}
                  action={
                    <Button variant="secondary" onClick={() => window.location.reload()}>
                      {t("build.reload")}
                    </Button>
                  }
                >
                  {t("build.newBody", { version: buildLabel(newBuild) })}
                </Banner>
              </div>
            )}
            {page === "cli-tools" ? (
              <CliTools tool={cliToolFromHash(hash)} />
            ) : page === "media" ? (
              <Media tab={/^#\/media\/([a-z-]+)$/.exec(hash)?.[1] ?? null} />
            ) : page === "proxy-pools" ? (
              <ProxyPools />
            ) : page === "skills" ? (
              <Skills />
            ) : page === "logs" ? (
              <Logs />
            ) : page === "chat" ? (
              <BasicChat />
            ) : page === "translator" ? (
              <Translator />
            ) : page === "settings" ? (
              <Settings />
            ) : page === "pricing" ? (
              <Pricing />
            ) : page === "usage" ? (
              <Usage />
            ) : page === "quota" ? (
              <Quota />
            ) : page === "token-saver" ? (
              <TokenSaver />
            ) : page === "combos" ? (
              <Combos />
            ) : page === "providers" ? (
              provider ? (
                <ProviderDetail key={provider} id={provider} />
              ) : (
                <Providers query={providerQuery} />
              )
            ) : (
              <Systems />
            )}
          </Container>
          {paletteOpen && <ConsolePalette pages={translatorShown ? PAGES : PAGES.filter((p) => p.id !== "translator")} onClose={() => setPaletteOpen(false)} />}
        </AppShell>
      </ShellTitleContext.Provider>
    </NotifyContext.Provider>
  );
}
