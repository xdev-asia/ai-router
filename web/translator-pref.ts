import { useSyncExternalStore } from "react";

/** Whether the Translator page shows in the sidebar: a developer tool, off until the owner turns it on in this browser. */
const STORAGE_KEY = "ai-router.translator";

function saved(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

let current: boolean | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = (): boolean => (current ??= saved());

function setShown(next: boolean): void {
  try {
    if (next) localStorage.setItem(STORAGE_KEY, "on");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable: the choice lasts for this page view only
  }
  current = next;
  listeners.forEach((l) => l());
}

/** One value for the whole page, so the sidebar and the Settings switch agree. */
export function useTranslatorShown(): [boolean, (next: boolean) => void] {
  return [useSyncExternalStore(subscribe, snapshot, () => false), setShown];
}

/** Tests only: forget the value read from storage. */
export function resetTranslatorShown(): void {
  current = null;
}
