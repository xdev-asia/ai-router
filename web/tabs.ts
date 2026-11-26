// Page tabs above each page (xdev-ui-admin console-chrome, "Page tabs"): the pages opened this session, Overview first.
// Pure list logic here; the strip itself is in App.tsx. A tab holds the route path, never the title, so tabs follow a
// language switch.

/** A tab: the hash route without `#` and without the query (`/providers/openai`). */
export interface OpenPage {
  path: string;
}

/** Overview: always first, never closed. */
export const HOME = "/overview";
/** At most this many tabs; the oldest go first, never home or the page just opened. */
export const MAX_TABS = 10;

/** The tab path of a hash: `#/usage?tab=details` -> `/usage`; an empty hash is Overview. */
export function tabPathOf(hash: string): string {
  const path = hash.replace(/^#/, "").split("?")[0];
  return path === "" || path === "/" ? HOME : path;
}

/** Home first, then the others in the order they were opened, each once, at most `max`. */
export function visitTab(tabs: readonly OpenPage[], path: string, max = MAX_TABS): OpenPage[] {
  let next = tabs.some((t) => t.path === path) ? [...tabs] : [...tabs, { path }];
  if (!next.some((t) => t.path === HOME)) next = [{ path: HOME }, ...next];
  next = [...next.filter((t) => t.path === HOME), ...next.filter((t) => t.path !== HOME)];
  while (next.length > max) {
    const i = next.findIndex((t) => t.path !== HOME && t.path !== path);
    if (i < 0) break;
    next.splice(i, 1);
  }
  return next;
}

export type TabAction = "close" | "others" | "left" | "right" | "all";

/** The tabs after a close action on `target`, and where to go when the open page closed: its right neighbour, else its left, else home. */
export function closeTabs(tabs: readonly OpenPage[], action: TabAction, target: string, current: string): { tabs: OpenPage[]; go: string | null } {
  const at = tabs.findIndex((t) => t.path === target);
  if (at < 0) return { tabs: [...tabs], go: null };
  const drop = (t: OpenPage, i: number): boolean => {
    if (t.path === HOME) return false;
    if (action === "close") return i === at;
    if (action === "others") return i !== at;
    if (action === "left") return i < at;
    if (action === "right") return i > at;
    return true;
  };
  const next = tabs.filter((t, i) => !drop(t, i));
  if (next.some((t) => t.path === current)) return { tabs: next, go: null };
  const cur = tabs.findIndex((t) => t.path === current);
  const right = tabs.slice(cur + 1).find((t) => next.includes(t));
  const left = [...tabs.slice(0, Math.max(cur, 0))].reverse().find((t) => next.includes(t));
  return { tabs: next, go: (right ?? left)?.path ?? HOME };
}

/** Stored tabs back to a list; anything malformed is dropped. */
export function readTabs(raw: string | null | undefined): OpenPage[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is OpenPage => !!x && typeof (x as OpenPage).path === "string" && (x as OpenPage).path.startsWith("/")).map((x) => ({ path: x.path })) : [];
  } catch {
    return [];
  }
}

/** Keeps `tab` in view inside the scrolling `strip` (not scrollIntoView, which would also move the page). */
export function keepTabInView(strip: HTMLElement, tab: HTMLElement): () => void {
  const reveal = (): void => {
    const s = strip.getBoundingClientRect();
    const r = tab.getBoundingClientRect();
    if (r.left < s.left) strip.scrollLeft -= s.left - r.left;
    else if (r.right > s.right) strip.scrollLeft += r.right - s.right;
  };
  reveal();
  let live = true;
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => live && reveal());
  ro?.observe(strip);
  ro?.observe(tab);
  document.fonts?.ready.then(() => live && reveal(), () => undefined);
  return () => {
    live = false;
    ro?.disconnect();
  };
}
