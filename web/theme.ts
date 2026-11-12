import { useEffect, useState } from "react";
import { PREFERS_DARK_QUERY, THEME_PREFERENCES, applyTheme, resolveTheme, watchSystemTheme, type ThemePreference } from "@xdev-asia/ui";

/** Also read by the script in index.html, which paints the theme before the first frame. */
const STORAGE_KEY = "xdev-llm.theme";

function savedTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if ((THEME_PREFERENCES as readonly string[]).includes(v ?? "")) return v as ThemePreference;
  } catch {
    // storage unavailable: follow the system
  }
  return "system";
}

/** The theme the user picked (system, dark or light): painted on <html>, kept in this browser, and following the system while on "system". */
export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  const [pref, setPref] = useState<ThemePreference>(savedTheme);
  useEffect(() => {
    const matchMedia = typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null;
    const paint = (prefersDark: boolean) => applyTheme(document.documentElement, resolveTheme(pref, prefersDark));
    paint(matchMedia ? matchMedia(PREFERS_DARK_QUERY).matches : true);
    if (pref !== "system" || !matchMedia) return;
    return watchSystemTheme(matchMedia, paint);
  }, [pref]);
  return [
    pref,
    (next) => {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // storage unavailable: the choice lasts for this page view only
      }
      setPref(next);
    },
  ];
}
