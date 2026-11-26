import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { AppShell, Banner, BrandMark, Breadcrumb, Button, Container, IconButton, Menu, MenuButton, NavList, PageHeader, PaletteTrigger, Popover, ServiceStatus, Spinner, TabStrip, ThemeSwitch, type BreadcrumbItem, type IconName } from "@xdev-asia/ui";
import { checkSession, setAuth, signOut, useAuth, useLoad, type Auth, type Combo, type Connection } from "./api";
import { t, useLang, type StringKey } from "./i18n";
import { LANGS, LangSelect } from "./LangSelect";
import { NotifyContext, useToasts } from "./notify";
import { ConsolePalette } from "./palette";
import { SignIn } from "./pages/SignIn";
import { Combos } from "./pages/Combos";
import { ProviderDetail, Providers } from "./pages/Providers";
import { Systems } from "./pages/Systems";
import { TokenSaver } from "./pages/TokenSaver";
import { Quota } from "./pages/Quota";
import { Usage } from "./pages/Usage";
import { Overview } from "./pages/Overview";
import { CliTools } from "./pages/CliTools";
import { Mcp } from "./pages/Mcp";
import { Logs } from "./pages/Logs";
import { Clips } from "./pages/Clips";
import { Media } from "./pages/Media";
import { ProxyPools } from "./pages/ProxyPools";
import { Settings } from "./pages/Settings";
import { Pricing } from "./pages/Pricing";
import { Skills } from "./pages/Skills";
import { Translator } from "./pages/Translator";
import { BasicChat } from "./pages/BasicChat";
import { PageHeadContext, type PageHead } from "./shell";
import { HOME, closeTabs, keepTabInView, readTabs, tabPathOf, visitTab, type OpenPage, type TabAction } from "./tabs";
import { useTheme } from "./theme";
import { useTranslatorShown } from "./translator-pref";
import { ui } from "./ui-labels";
import { hashRoute } from "./url-state";
import { BUILD, buildLabel, useNewBuild } from "./version";

export type Page = "overview" | "systems" | "providers" | "combos" | "cli-tools" | "mcp" | "usage" | "quota" | "token-saver" | "media" | "proxy-pools" | "skills" | "logs" | "translator" | "chat" | "settings" | "pricing" | "clips";

/** Sidebar order, icons and the strings of each page's title in the top bar. */
const PAGES: { id: Page; nav: StringKey; title: StringKey; description: StringKey; icon: IconName }[] = [
  { id: "overview", nav: "nav.overview", title: "overview.title", description: "overview.description", icon: "home" },
  { id: "systems", nav: "nav.systems", title: "systems.title", description: "systems.description", icon: "key" },
  { id: "providers", nav: "nav.providers", title: "providers.title", description: "providers.description", icon: "plug" },
  { id: "combos", nav: "nav.combos", title: "combos.title", description: "combos.description", icon: "layers" },
  { id: "cli-tools", nav: "nav.cliTools", title: "cli.title", description: "cli.description", icon: "terminal" },
  { id: "mcp", nav: "nav.mcp", title: "mcp.title", description: "mcp.description", icon: "bot" },
  { id: "usage", nav: "nav.usage", title: "usage.title", description: "usage.description", icon: "activity" },
  { id: "quota", nav: "nav.quota", title: "quota.title", description: "quota.description", icon: "clock" },
  { id: "token-saver", nav: "nav.tokenSaver", title: "saver.title", description: "saver.description", icon: "zap" },
  { id: "clips", nav: "nav.clips", title: "clips.title", description: "clips.description", icon: "play" },
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
  { title: "nav.title", pages: ["overview", "systems", "providers", "combos", "cli-tools", "mcp"] },
  { title: "nav.insight", pages: ["usage", "quota", "token-saver"] },
  { title: "nav.system", pages: ["clips", "media", "proxy-pools", "skills", "logs", "translator", "settings", "pricing"] },
];

/**
 * Hash routes (`#/<page>`, `#/providers/<id>`, `#/media/<tab>`), so no page path ever collides with the /admin API.
 * A page may keep its filters after a `?` (`#/logs?level=error`, see url-state.ts); routing ignores them.
 */
export function pageFromHash(full: string): Page {
  const hash = hashRoute(full);
  if (hash === "#/providers" || hash.startsWith("#/providers/")) return "providers";
  if (hash === "#/media" || hash.startsWith("#/media/")) return "media";
  if (hash === "#/clips" || hash.startsWith("#/clips/")) return "clips";
  if (hash.startsWith("#/cli-tools/")) return "cli-tools";
  const id = hash.slice(2);
  return PAGES.some((p) => p.id === id) ? (id as Page) : "overview";
}

/** The provider of `#/providers/<id>`; null on any other page. */
export function providerFromHash(hash: string): string | null {
  return /^#\/providers\/([a-z][a-z0-9-]{0,31})$/.exec(hashRoute(hash))?.[1] ?? null;
}

/** The tool of `#/cli-tools/<id>`; null on any other page. */
export function cliToolFromHash(hash: string): string | null {
  return /^#\/cli-tools\/([a-z][a-z0-9-]{0,31})$/.exec(hashRoute(hash))?.[1] ?? null;
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
  // False until the first /auth/me answers: a reload waits for the session instead of drawing the sign-in page.
  const [checked, setChecked] = useState(false);

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
      setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [auth]);

  if (auth) return <Console auth={auth} />;
  if (!checked) {
    return (
      <div className="app-boot" aria-busy="true">
        <Spinner size="md" labels={{ loading: t("loading") }} />
      </div>
    );
  }
  return <SignIn sso={sso} />;
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

const TABS_KEY = "ai-router.tabs";
const RAIL_KEY = "ai-router.nav-rail";

function readStored(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };
  return [on, toggle];
}

/** The tab a route belongs to: a page's own sub-views (Media's tabs) share one tab. */
const tabOf = (hash: string): string => {
  const path = tabPathOf(hashRoute(hash));
  return path.startsWith("/media/") ? "/media" : path.startsWith("/clips/") ? "/clips" : path;
};

/**
 * The console's frame, as the xdev-ui admin layout (console-chrome): a 48px top bar with the breadcrumb, search and
 * account; a sidebar that folds to a rail; the open pages as tabs; the page header at the top of the page.
 */
function Console({ auth }: { auth: NonNullable<Auth> }) {
  const [lang, setLang] = useLang();
  const hash = useHash();
  const page = pageFromHash(hash);
  const provider = providerFromHash(hash);
  const labels = ui(lang);
  const { notify, toasts } = useToasts();
  const [navOpen, setNavOpen] = useState(false);
  const [rail, setRail] = useState(() => readStored(RAIL_KEY) === "1");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusView, setFocusView] = useState(false);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const [theme, setTheme, shownTheme] = useTheme();
  const [translatorShown] = useTranslatorShown();
  const [head, setHead] = useState<PageHead | null>(null);
  const [tabs, setTabs] = useState<OpenPage[]>(() => readTabs(readStored(TABS_KEY)));
  const [tabMenu, setTabMenu] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** Names of the detail pages seen this session (a provider, a CLI tool), so their tabs keep them. */
  const [names, setNames] = useState<Record<string, string>>({});
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stats = useNavStats(page);
  const newBuild = useNewBuild();

  const shown = translatorShown ? PAGES : PAGES.filter((p) => p.id !== "translator");
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];
  const group = GROUPS.find((g) => g.pages.includes(current.id)) ?? GROUPS[0];
  const tabPath = tabOf(hash);
  const title = head?.title ?? t(current.title);
  const themes = ["system", "dark", "light"] as const;

  useEffect(() => {
    if (head) setNames((m) => (m[tabPath] === head.title ? m : { ...m, [tabPath]: head.title }));
  }, [head, tabPath]);
  useEffect(() => setTabs((list) => visitTab(list, tabPath)), [tabPath]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(TABS_KEY, JSON.stringify(tabs));
    } catch {
      // storage blocked: tabs last for this page view
    }
  }, [tabs]);
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_KEY, rail ? "1" : "0");
    } catch {
      // storage blocked
    }
  }, [rail]);
  useEffect(() => {
    document.title = `${title} · ${t("app.name")}`;
  }, [title, lang]);
  useEffect(() => {
    if (!focusView) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setFocusView(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusView]);
  useEffect(() => {
    const strip = stripRef.current?.querySelector<HTMLElement>(".ws-tabstrip");
    const tab = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.closest<HTMLElement>(".ws-tab");
    if (!strip || !tab) return;
    return keepTabInView(strip, tab);
  }, [tabPath, tabs]);

  /** A tab's name and icon in the current language: the page's menu name, or a detail page's own name. */
  const tabInfo = (path: string): { name: string; icon?: IconName } => {
    const id = path.split("/")[1];
    const p = PAGES.find((x) => x.id === id);
    const detail = path.split("/")[2];
    if (p && detail) return { name: names[path] ?? decodeURIComponent(detail), icon: p.icon };
    return p ? { name: t(p.nav), icon: p.icon } : { name: path };
  };
  const go = (path: string) => {
    window.location.hash = `#${path}`;
  };
  const act = (action: TabAction, target: string) => {
    setTabMenu(null);
    const next = closeTabs(tabs, action, target, tabPath);
    setTabs(next.tabs);
    if (next.go) go(next.go);
  };
  const onTabContext = (e: MouseEvent<HTMLDivElement>) => {
    const tab = (e.target as HTMLElement).closest('[role="tab"]');
    const at = tab ? Array.from(stripRef.current?.querySelectorAll('[role="tab"]') ?? []).indexOf(tab) : -1;
    const hit = tabs[at];
    if (!hit) return;
    e.preventDefault();
    setTabMenu(hit.path);
  };
  const menuFor = (path: string) => {
    const at = tabs.findIndex((x) => x.path === path);
    return [
      { label: t("shell.reloadPage"), disabled: path !== tabPath, onSelect: () => { setTabMenu(null); setReload((n) => n + 1); } },
      { type: "separator" as const },
      { label: t("shell.closeTab"), disabled: at < 0 || path === HOME, onSelect: () => act("close", path) },
      { label: t("shell.closeLeft"), disabled: !tabs.slice(0, Math.max(at, 0)).some((x) => x.path !== HOME), onSelect: () => act("left", path) },
      { label: t("shell.closeRight"), disabled: at < 0 || at >= tabs.length - 1, onSelect: () => act("right", path) },
      { type: "separator" as const },
      { label: t("shell.closeOthers"), disabled: !tabs.some((x, i) => i !== at && x.path !== HOME), onSelect: () => act("others", path) },
      { label: t("shell.closeAll"), disabled: !tabs.some((x) => x.path !== HOME), onSelect: () => act("all", path) },
    ];
  };

  const crumbs: BreadcrumbItem[] = head
    ? [{ label: t(group.title) }, { label: head.parent.label, href: head.parent.href }, { label: head.title }]
    : [{ label: t(group.title) }, { label: t(current.nav), href: `#/${current.id}` }];
  return (
    <NotifyContext.Provider value={notify}>
      <PageHeadContext.Provider value={setHead}>
        <AppShell
          labels={labels.appShell}
          navOpen={navOpen}
          onNavOpenChange={setNavOpen}
          navCollapsed={rail}
          chromeHidden={focusView}
          toasts={toasts}
          brand={
            <a className="console-brand" href={`#${HOME}`}>
              <BrandMark size={20} />
              <span translate="no">{t("app.name")}</span>
            </a>
          }
          nav={GROUPS.map((g) => (
            <NavList
              key={g.title}
              title={t(g.title)}
              labels={{ ...labels.navList, nav: t(g.title) }}
              value={page}
              onSelect={() => setNavOpen(false)}
              items={shown.filter((p) => g.pages.includes(p.id)).map((p) => ({ id: p.id, label: t(p.nav), icon: p.icon, href: `#/${p.id}`, ...stats[p.id] }))}
            />
          ))}
          navFooter={
            <div className="console-nav-foot">
              <ServiceStatus tone="ok" label={t("shell.online")} detail={buildLabel(BUILD)} />
              <span className="console-wide-only">
                <IconButton icon="sidebar" label={rail ? labels.appShell.expandNav : labels.appShell.collapseNav} aria-expanded={!rail} onClick={() => setRail(!rail)} />
              </span>
            </div>
          }
          crumbs={<Breadcrumb className="console-crumbs" items={crumbs} labels={labels.breadcrumb} />}
          actions={
            <>
              <PaletteTrigger className="console-top-search" onOpen={() => setPaletteOpen(true)} labels={{ search: t("palette.trigger") }} />
              <span className="console-wide-only">
                <ThemeSwitch variant="icon" value={theme} resolved={shownTheme} onChange={setTheme} labels={{ toDark: t("theme.toDark"), toLight: t("theme.toLight") }} />
              </span>
              <span className="console-wide-only">
                <LangSelect />
              </span>
              <span className="console-wide-only">
                <IconButton icon={fullscreen ? "minimize" : "maximize"} label={fullscreen ? t("shell.exitFullscreen") : t("shell.fullscreen")} onClick={toggleFullscreen} />
              </span>
              {auth.kind === "sso" && <span className="console-user console-wide-only">{auth.email}</span>}
              <MenuButton
                variant="icon"
                icon="more"
                align="end"
                label={t("shell.account")}
                items={[
                  { type: "group", label: t("theme.group") },
                  ...themes.map((v) => ({ label: t(`theme.${v}`), checked: theme === v, onSelect: () => setTheme(v) })),
                  { type: "group", label: t("shell.lang") },
                  ...LANGS.map((l) => ({ label: l.label, checked: lang === l.value, onSelect: () => setLang(l.value) })),
                  { type: "separator" },
                  { label: t("shell.signOut"), onSelect: () => void signOut() },
                ]}
              />
            </>
          }
        >
          {tabs.length > 0 && (
            <div className="console-tabs">
              <div className="console-tabs-strip" ref={stripRef} onContextMenu={onTabContext}>
                <TabStrip
                  label={t("shell.openPages")}
                  labels={labels.tabStrip}
                  tabs={tabs.map((x) => ({ id: x.path, ...tabInfo(x.path), pinned: x.path === HOME }))}
                  selected={tabPath}
                  onSelect={go}
                  onClose={(path) => act("close", path)}
                  onReorder={(ids) => setTabs((list) => ids.flatMap((id) => list.filter((x) => x.path === id)))}
                  onAdd={false}
                />
              </div>
              <div className="console-tabs-tools">
                <IconButton icon="refresh" label={t("shell.reloadPage")} onClick={() => setReload((n) => n + 1)} />
                <IconButton icon={focusView ? "minimize" : "maximize"} label={focusView ? t("shell.exitFocus") : t("shell.focus")} aria-pressed={focusView} onClick={() => setFocusView(!focusView)} />
                <Popover
                  open={tabMenu !== null}
                  onClose={() => setTabMenu(null)}
                  placement="bottom-end"
                  label={t("shell.tabActions")}
                  trigger={(a) => <IconButton icon="chevron" label={t("shell.tabActions")} onClick={() => setTabMenu(tabMenu === null ? tabPath : null)} {...a} />}
                >
                  <Menu label={t("shell.tabActions")} items={menuFor(tabMenu ?? tabPath)} onClose={() => setTabMenu(null)} />
                </Popover>
              </div>
            </div>
          )}
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
            {/* A new key remounts the page, so "Reload page" fetches it again without reloading the console. */}
            <div key={`${tabPath}-${reload}`} className="console-page">
              <PageHeader
                title={
                  head?.media ? (
                    <span className="console-title">
                      <span aria-hidden="true">{head.media}</span>
                      {head.title}
                    </span>
                  ) : (
                    title
                  )
                }
                description={head ? undefined : t(current.description)}
              />
              {page === "cli-tools" ? (
                <CliTools tool={cliToolFromHash(hash)} />
              ) : page === "mcp" ? (
                <Mcp />
              ) : page === "clips" ? (
                <Clips hash={hashRoute(hash)} />
              ) : page === "media" ? (
                <Media tab={/^#\/media\/([a-z-]+)$/.exec(hashRoute(hash))?.[1] ?? null} />
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
                  <Providers />
                )
              ) : page === "systems" ? (
                <Systems />
              ) : (
                <Overview />
              )}
            </div>
          </Container>
          {paletteOpen && <ConsolePalette pages={shown} onClose={() => setPaletteOpen(false)} />}
        </AppShell>
      </PageHeadContext.Provider>
    </NotifyContext.Provider>
  );
}
