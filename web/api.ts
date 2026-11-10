import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The admin token lives in this module only: not in localStorage, sessionStorage or a cookie,
 * so it is gone when the tab closes or reloads.
 */
let token: string | null = null;
const listeners = new Set<() => void>();

export function setToken(next: string | null): void {
  token = next;
  listeners.forEach((l) => l());
}

export function useToken(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => token,
    () => null,
  );
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Calls /admin with the admin token. A 401 signs the console out. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const bearer = init.token ?? token;
  const res = await fetch(`/admin${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: `Bearer ${bearer ?? ""}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    if (init.token === undefined) setToken(null);
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? String(res.status));
  }
  return (await res.json()) as T;
}

export type LoadState<T> = { status: "loading" } | { status: "error"; code: string } | { status: "ready"; data: T };

/** Loads an admin resource; `reload()` fetches it again and keeps the old data on screen meanwhile. */
export function useLoad<T>(path: string): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    api<T>(path).then(
      (data) => live && setState({ status: "ready", data }),
      (e: unknown) => live && setState({ status: "error", code: e instanceof ApiError ? e.code : "failed" }),
    );
    return () => {
      live = false;
    };
  }, [path, tick]);
  return [state, () => setTick((n) => n + 1)];
}

export interface System {
  id: string;
  name: string;
  monthly_token_cap: number | null;
  disabled: boolean;
  created_at: number;
}

export interface UsageRow {
  system_id: string;
  provider: string;
  model: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface UsageReport {
  month: string;
  rows: UsageRow[];
}

/** Tokens a row counts against the cap: the same sum the gateway uses. */
export const capTokens = (r: UsageRow): number =>
  r.input_tokens + r.output_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens;
