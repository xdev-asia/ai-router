import type { Hono } from "hono";
import { syncModels, syncedModels } from "./model-sync";
import type { System } from "./auth";
import { candidatesFor } from "./connections";
import type { AppEnv } from "./env";
import { CATALOG } from "./model-catalog";
import { customModels, disabledSet, getProviderThinking, loadAliases, saveProviderThinking, stripMarkers } from "./models";
import { COMBO_NAME, aliasOf, isModelName, isProvider, parseModel, type ProviderId } from "./providers";
import { OFF } from "./savers";
import type { Upstream } from "./proxy";
import { resolveModel, runChat } from "./route";

/** How long the console's model test waits for an answer. */
const TEST_TIMEOUT_MS = 15_000;

/** The model test runs as no system: it may call any model, and record() keeps no usage row for it. */
const PROBE: System = { id: "", name: "model test", monthly_token_cap: null, disabled: false, created_at: 0, allowed_models: '["*"]', rtk: false, caveman: null, ponytail: null };

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const now = () => Math.floor(Date.now() / 1000);

/** The keys a provider's test uses: for Anthropic, those of the first system with a key; else the provider's. */
function keySystemFor(env: AppEnv["Bindings"], provider: ProviderId): string {
  if (provider !== "anthropic" || !env.ANTHROPIC_KEYS) return provider;
  try {
    const keys = JSON.parse(env.ANTHROPIC_KEYS) as Record<string, unknown>;
    return Object.entries(keys).find(([, k]) => typeof k === "string" && k !== "")?.[0] ?? provider;
  } catch {
    return provider;
  }
}

/**
 * The console's model API (FR-MDL-04, 06, 07, 09, 10, 12), with fixed error strings: a provider's model card,
 * aliases, disabled and added models, each provider's Thinking mode, and a one-message model test.
 */
export function modelRoutes(a: Hono<AppEnv>, upstream: Upstream): void {
  a.get("/providers/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!isProvider(id)) return c.json({ error: "not_found" }, 404);
    const cat = CATALOG[id];
    const disabled = await disabledSet(c.env.DB);
    const off = (m: string) => disabled.has(`${id}/${m}`);
    const custom = await customModels(c.env.DB, id);
    const own = new Set(custom.map((m) => m.model));
    // The provider's own list (model-sync.ts): it adds models the catalog lacks, and levels and context to known ones.
    const sync = await syncedModels(c.env.DB, id);
    const synced = new Map(sync.models.map((m) => [m.id, m]));
    const fill = <T extends { id: string; thinking?: readonly string[]; context?: number }>(m: T) => {
      const s = synced.get(m.id);
      return s ? { ...m, synced: true, ...(!m.thinking && s.thinking ? { thinking: s.thinking } : {}), ...(!m.context && s.context ? { context: s.context } : {}) } : m;
    };
    const known = new Set([...own, ...(cat?.models ?? []).map((m) => m.id)]);
    const models = [
      ...sync.models
        .filter((m) => !known.has(m.id))
        .map((m) => ({ id: m.id, name: m.name, custom: false, disabled: off(m.id), synced: true, new: m.new, ...(m.thinking ? { thinking: m.thinking } : {}), ...(m.context ? { context: m.context } : {}) })),
      ...custom.map((m) => fill({ id: m.model, name: m.name ?? m.model, custom: true, disabled: off(m.model) })),
      ...(cat?.models ?? [])
        .filter((m) => !own.has(m.id))
        .map((m) =>
          fill({
            id: m.id,
            name: m.name,
            custom: false,
            disabled: off(m.id),
            ...(m.thinking ? { thinking: [...m.thinking] } : {}),
            ...(m.context ? { context: m.context } : {}),
          }),
        ),
    ];
    const saved = (await getProviderThinking(c.env.DB))[id];
    const thinking = cat?.thinking ? { options: [...cat.thinking.options], mode: saved ?? cat.thinking.default } : null;
    return c.json({ provider: id, alias: aliasOf(id), thinking, models, sync: sync.state });
  });

  /** Fetches the provider's own model list now (model-sync.ts). 409 without a connection, 502 when it fails. */
  a.post("/providers/:id/models/sync", async (c) => {
    const id = c.req.param("id");
    if (!isProvider(id)) return c.json({ error: "not_found" }, 404);
    const r = await syncModels(c.env, upstream, id);
    if (!r.ok) return c.json({ error: r.status === 400 ? "not_supported" : r.status === 409 ? "no_connection" : "sync_failed", message: r.message }, r.status);
    const { ok: _ok, ...body } = r;
    return c.json(body);
  });

  a.get("/models/aliases", async (c) => c.json({ aliases: await loadAliases(c.env.DB) }));

  a.put("/models/aliases", async (c) => {
    const b = await readJson(c.req.raw);
    const alias = str(b?.alias);
    const model = str(b?.model);
    if (!alias || !model) return c.json({ error: "Model and alias required" }, 400);
    if (!COMBO_NAME.test(alias) || alias.includes("/")) return c.json({ error: "Alias: letters, digits, . _ - only" }, 400);
    if (!parseModel(stripMarkers(model).model)) return c.json({ error: "Model: use provider/model or combo/name" }, 400);
    await c.env.DB.prepare("INSERT INTO model_alias (alias, model, updated_at) VALUES (?, ?, ?) ON CONFLICT (alias) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at")
      .bind(alias, model, now())
      .run();
    return c.json({ alias, model });
  });

  a.delete("/models/aliases", async (c) => {
    const alias = str(c.req.query("alias"));
    if (!alias) return c.json({ error: "Alias required" }, 400);
    await c.env.DB.prepare("DELETE FROM model_alias WHERE alias = ?").bind(alias).run();
    return c.json({ deleted: alias });
  });

  a.post("/models/disabled", async (c) => {
    const b = await readJson(c.req.raw);
    const provider = str(b?.provider);
    const ids = Array.isArray(b?.ids) ? (b!.ids as unknown[]).filter(isModelName) : null;
    if (!provider || !ids) return c.json({ error: "provider and ids[] required" }, 400);
    if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
    const t = now();
    if (ids.length) await c.env.DB.batch(ids.map((m) => c.env.DB.prepare("INSERT OR IGNORE INTO model_disabled (provider, model, created_at) VALUES (?, ?, ?)").bind(provider, m, t)));
    return c.json({ provider, disabled: ids.length });
  });

  a.delete("/models/disabled", async (c) => {
    const provider = str(c.req.query("provider"));
    const id = str(c.req.query("id"));
    if (!provider) return c.json({ error: "provider required" }, 400);
    const q = id
      ? c.env.DB.prepare("DELETE FROM model_disabled WHERE provider = ? AND model = ?").bind(provider, id)
      : c.env.DB.prepare("DELETE FROM model_disabled WHERE provider = ?").bind(provider);
    await q.run();
    return c.json({ provider, enabled: id ?? "all" });
  });

  a.post("/models/custom", async (c) => {
    const b = await readJson(c.req.raw);
    const provider = str(b?.provider);
    const id = str(b?.id);
    if (!provider || !id) return c.json({ error: "provider and id required" }, 400);
    if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
    if (!isModelName(id)) return c.json({ error: "Model ID: letters, digits and . _ : - [ ] only" }, 400);
    const name = str(b?.name)?.slice(0, 100) ?? null;
    await c.env.DB.prepare("INSERT INTO model_custom (provider, model, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (provider, model) DO UPDATE SET name = excluded.name")
      .bind(provider, id, name, now())
      .run();
    return c.json({ provider, id, name: name ?? id });
  });

  a.delete("/models/custom", async (c) => {
    const provider = str(c.req.query("provider"));
    const id = str(c.req.query("id"));
    if (!provider || !id) return c.json({ error: "provider and id required" }, 400);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM model_custom WHERE provider = ? AND model = ?").bind(provider, id),
      c.env.DB.prepare("DELETE FROM model_disabled WHERE provider = ? AND model = ?").bind(provider, id),
    ]);
    return c.json({ deleted: id });
  });

  a.put("/models/thinking", async (c) => {
    const b = await readJson(c.req.raw);
    const provider = str(b?.provider);
    const mode = str(b?.mode);
    if (!provider || !mode) return c.json({ error: "provider and mode required" }, 400);
    const options = isProvider(provider) ? CATALOG[provider]?.thinking?.options : undefined;
    if (!options || !(options as readonly string[]).includes(mode)) return c.json({ error: "This provider has no such thinking mode" }, 400);
    const modes = await getProviderThinking(c.env.DB);
    if (mode === "auto") delete modes[provider];
    else modes[provider] = mode;
    await saveProviderThinking(c.env.DB, modes);
    return c.json({ provider, mode });
  });

  /** Sends "hi" to the model with the gateway's own keys (FR-MDL-07). No usage row; the answer is not shown. */
  a.post("/models/test", async (c) => {
    const b = await readJson(c.req.raw);
    const model = str(b?.model);
    if (!model) return c.json({ error: "Model required" }, 400);
    const resolved = await resolveModel(c.env.DB, model);
    if (!resolved) return c.json({ ok: false, error: `Unknown model: ${model}` });
    let keySystem: string | undefined;
    if (resolved.ref.kind === "target") {
      const p = resolved.ref.target.provider;
      keySystem = keySystemFor(c.env, p);
      if ((await candidatesFor(c.env, p, keySystem, now())).length === 0) return c.json({ ok: false, error: `No active credentials for provider: ${p}` });
    }
    const started = Date.now();
    const body = { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1024, stream: false };
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TEST_TIMEOUT_MS));
    const res = await Promise.race([runChat(c, upstream, PROBE, body, { keySystem, savers: OFF }).catch(() => null), timeout]);
    const latency_ms = Date.now() - started;
    if (!res) return c.json({ ok: false, error: `No answer in ${TEST_TIMEOUT_MS / 1000}s`, latency_ms });
    if (res.ok) {
      await res.body?.cancel();
      return c.json({ ok: true, latency_ms });
    }
    const text = await res.text();
    let error = `HTTP ${res.status}`;
    try {
      const m = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
      if (typeof m === "string" && m) error = `${error}: ${m}`;
    } catch {
      // Not JSON: the status says enough.
    }
    return c.json({ ok: false, error, latency_ms });
  });
}
