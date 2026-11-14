import { useEffect, useState } from "react";

/** The build this console comes from: the commit CI built the image from, or `dev` (vite.config.ts). */
export const BUILD = __APP_VERSION__;

/** How a build shows: a commit by its first 7 characters, anything else as it is. */
export function buildLabel(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
}

/**
 * What to do once the gateway says which build it runs. Watchtower swaps the container for each new image, and the
 * old page's script chunks are then gone, so a page nobody is looking at reloads; one in use only offers it.
 */
export function buildStep(current: string, server: string | null, hidden: boolean): "none" | "reload" | "notify" {
  if (!server || server === current) return "none";
  return hidden ? "reload" : "notify";
}

const EVERY_MS = 60_000;

/** The gateway's build when it is not this page's, checked on load, every minute and when the tab comes back. */
export function useNewBuild(): string | null {
  const [found, setFound] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    async function check() {
      let server: string | null = null;
      try {
        const res = await fetch("/health", { cache: "no-store" });
        const body = res.ok ? ((await res.json()) as { version?: unknown }) : null;
        server = typeof body?.version === "string" ? body.version : null;
      } catch {
        return; // The gateway restarting for the new image: the next check sees it.
      }
      if (!live) return;
      const step = buildStep(BUILD, server, document.visibilityState === "hidden");
      if (step === "reload") window.location.reload();
      else if (step === "notify") setFound(server);
    }
    void check();
    const timer = setInterval(() => void check(), EVERY_MS);
    const onShow = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);
  return found;
}
