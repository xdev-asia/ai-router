import { useEffect, useState, useSyncExternalStore } from "react";
import { PREFERS_DARK_QUERY, THEME_PREFERENCES, applyTheme, resolveTheme, watchSystemTheme, type ResolvedTheme, type ThemePreference } from "@xdev-asia/ui";

/** Also read by the script in index.html, which paints the theme before the first frame. */
const STORAGE_KEY = "ai-router.theme";

function savedTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if ((THEME_PREFERENCES as readonly string[]).includes(v ?? "")) return v as ThemePreference;
  } catch {
    // storage unavailable: follow the system
  }
  return "system";
}

function systemDark(): boolean {
  return typeof window.matchMedia === "function" ? window.matchMedia(PREFERS_DARK_QUERY).matches : true;
}

/** One choice for the whole page, so the top bar's switch and the Settings page show the same theme. */
let current: ThemePreference | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = (): ThemePreference => (current ??= savedTheme());

function setTheme(next: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage unavailable: the choice lasts for this page view only
  }
  current = next;
  listeners.forEach((l) => l());
}

/** The theme the user picked (system, dark or light): painted on <html>, kept in this browser, and following the system while on "system". The third value is the theme on screen. */
export function useTheme(): [ThemePreference, (pref: ThemePreference) => void, ResolvedTheme] {
  const pref = useSyncExternalStore(subscribe, snapshot, () => "system" as ThemePreference);
  const [prefersDark, setPrefersDark] = useState(systemDark);
  useEffect(() => {
    const matchMedia = typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null;
    const paint = (dark: boolean) => {
      setPrefersDark(dark);
      applyTheme(document.documentElement, resolveTheme(pref, dark));
    };
    paint(matchMedia ? matchMedia(PREFERS_DARK_QUERY).matches : true);
    if (pref !== "system" || !matchMedia) return;
    return watchSystemTheme(matchMedia, paint);
  }, [pref]);
  return [pref, setTheme, resolveTheme(pref, prefersDark)];
}
