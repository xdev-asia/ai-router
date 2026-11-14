import { useSyncExternalStore } from "react";
import { en } from "./strings/en";
import { vi } from "./strings/vi";

export type Lang = "en" | "vi";
export type StringKey = keyof typeof en;

const STORAGE_KEY = "ai-router.lang";
const dictionaries: Record<Lang, Record<StringKey, string>> = { en, vi };

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "vi") return saved;
  } catch {
    // storage unavailable: fall through to the browser language
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("vi") ? "vi" : "en";
}

let current: Lang | null = null;
const listeners = new Set<() => void>();

function getLang(): Lang {
  current ??= detectLang();
  return current;
}

/** Forget the cached language so the next read detects it again (tests). */
export function resetLang(): void {
  current = null;
  listeners.forEach((l) => l());
}

function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage unavailable: the choice lasts for this page view only
  }
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

export function t(key: StringKey, vars?: Record<string, string>): string {
  const text = dictionaries[getLang()][key];
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m) : text;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLang(): [Lang, (lang: Lang) => void] {
  return [useSyncExternalStore(subscribe, getLang, () => "en"), setLang];
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(getLang() === "vi" ? "vi-VN" : "en-US").format(n);
}
