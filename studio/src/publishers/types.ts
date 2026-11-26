/** What every channel's publisher has in common. */

export interface Field {
  key: string;
  label: string;
  help?: string;
  optional?: boolean;
}

export interface PublishInput {
  /** The MP4 on disk. */
  file: string;
  /** final.mp4 where the internet can fetch it (PUBLIC_BASE_URL), if set. */
  videoUrl: string | null;
  coverUrl: string | null;
  title: string;
  /** Description and hashtags. */
  caption: string;
  hashtags: string[];
  /** Where the clip is already up (other channels), for channels that post a link. */
  links: string[];
}

export interface PublishContext {
  fetch: typeof fetch;
  /** Takes the place of every API host: tests point it at a fake server. */
  base?: string;
  pollMs?: number;
  /** Looks at a job this many times before giving up. */
  pollTries?: number;
}

export interface PublishResult {
  externalId: string;
  url: string | null;
  /** New credentials the platform handed back (a rotated refresh token): stored in place of the old ones. */
  secret?: Record<string, string>;
}

export interface Publisher {
  kind: string;
  name: string;
  secretFields: Field[];
  configFields: Field[];
  publish(secret: Record<string, string>, config: Record<string, string>, input: PublishInput, ctx: PublishContext): Promise<PublishResult>;
}

export class PublishError extends Error {}

/** `https://host/path` with the host replaced by `ctx.base` when set. */
export function at(ctx: PublishContext, url: string): string {
  if (!ctx.base) return url;
  const u = new URL(url);
  return ctx.base.replace(/\/+$/, "") + u.pathname + u.search;
}

/**
 * A call whose answer is JSON. A failure says the platform, the status and the platform's own message, never the
 * URL (it can hold a token).
 */
export async function callJson<T>(ctx: PublishContext, name: string, url: string, init: RequestInit): Promise<{ json: T; res: Response }> {
  let res: Response;
  try {
    res = await ctx.fetch(at(ctx, url), init);
  } catch (e) {
    throw new PublishError(`could not reach ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new PublishError(`${name} ${res.status}: ${platformMessage(json) ?? text.slice(0, 200)}`);
  return { json: json as T, res };
}

function platformMessage(j: unknown): string | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const e = o.error;
  if (typeof e === "string") return typeof o.error_description === "string" ? `${e}: ${o.error_description}` : e;
  if (e && typeof e === "object") {
    const m = (e as Record<string, unknown>).message;
    if (typeof m === "string" && m) return m;
  }
  for (const k of ["description", "message", "error_description"]) if (typeof o[k] === "string") return o[k] as string;
  return null;
}

export const need = (o: Record<string, string>, key: string, name: string): string => {
  const v = o[key];
  if (!v) throw new PublishError(`${name}: ${key} is not set`);
  return v;
};

export const wait = (ctx: PublishContext) => new Promise((r) => setTimeout(r, ctx.pollMs ?? 5000));

export const form = (o: Record<string, string>) => new URLSearchParams(o);
