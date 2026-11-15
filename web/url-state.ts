import { useCallback, useEffect, useState } from "react";

/** A hash route without its query: `#/logs?level=error` is `#/logs`. */
export function hashRoute(hash: string): string {
  const i = hash.indexOf("?");
  return i < 0 ? hash : hash.slice(0, i);
}

/** The query of a hash route: `#/logs?level=error` holds `level=error`. */
export function hashParams(hash: string): URLSearchParams {
  const i = hash.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : hash.slice(i + 1));
}

/**
 * The hash for `route` with `values` set on the current query. A value that is empty or equal to its default is
 * left out, so a page in its plain state keeps a plain address. A query that belongs to another route is dropped.
 */
export function withHashParams(route: string, current: string, values: Record<string, string>, defaults: Record<string, string>): string {
  const params = hashRoute(current) === route ? hashParams(current) : new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === "" || value === defaults[key]) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

/** The values of `defaults`' keys in the hash, when it is on `route`; a value outside `allowed` falls back to the default. */
function readHashParams<T extends Record<string, string>>(route: string, defaults: T, allowed: { [K in keyof T]?: readonly string[] }): T {
  const hash = window.location.hash;
  const out = { ...defaults };
  if (hashRoute(hash) !== route) return out;
  const params = hashParams(hash);
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const value = params.get(key);
    const ok = allowed[key];
    if (value !== null && (!ok || ok.includes(value))) out[key] = value as T[typeof key];
  }
  return out;
}

/**
 * Page state kept in the address (`#/logs?level=error&q=timeout`), so a reload, a shared link or Back shows the
 * same view. A change replaces the history entry instead of adding one: typing in a search box does not fill Back
 * with every letter. `defaults` and `allowed` are read once; pass constants.
 */
export function useHashParams<T extends Record<string, string>>(
  route: string,
  defaults: T,
  allowed: { [K in keyof T]?: readonly string[] } = {},
): [T, (next: Partial<T>) => void] {
  const [state, setState] = useState<T>(() => readHashParams(route, defaults, allowed));

  useEffect(() => {
    const onHash = () => {
      if (hashRoute(window.location.hash) === route) setState(readHashParams(route, defaults, allowed));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [route]);

  const update = useCallback(
    (next: Partial<T>) => {
      setState((s) => ({ ...s, ...next }));
      const hash = withHashParams(route, window.location.hash, next as Record<string, string>, defaults);
      if (hash !== window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
    },
    [route],
  );

  return [state, update];
}
