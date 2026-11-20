import { useState } from "react";
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FormDialog,
  MenuButton,
  Segmented,
  Select,
  SettingRow,
  Skeleton,
  Stack,
  StatusDot,
  type DataTableColumn,
} from "@xdev-asia/ui";
import { ApiError, api, useLoad } from "../api";
import { t, useLang, type Lang, type StringKey } from "../i18n";
import { useNotify } from "../notify";
import { ui } from "../ui-labels";
import { formatAgo } from "./Usage";

/** The environment variable the snippets read the MCP token from: no config file holds the token itself. */
export const MCP_TOKEN_VAR = "AI_ROUTER_MCP_TOKEN";
export type McpClient = "claude" | "codex" | "cursor" | "other";
export interface McpSnippet {
  where: StringKey;
  language: string;
  code: string;
}

/**
 * How each MCP client reaches this gateway's /mcp with the token from MCP_TOKEN_VAR (docs checked 2026-11-20:
 * code.claude.com/docs/en/mcp, learn.chatgpt.com/docs/extend/mcp, cursor.com/docs/context/mcp).
 */
export function mcpSnippets(client: McpClient, origin: string): McpSnippet[] {
  const url = `${origin.replace(/\/+$/, "")}/mcp`;
  const v = MCP_TOKEN_VAR;
  switch (client) {
    case "claude":
      return [{ where: "prefs.mcp.where.claude", language: "json", code: JSON.stringify({ mcpServers: { "ai-router": { type: "http", url, headers: { Authorization: `Bearer \${${v}}` } } } }, null, 2) }];
    case "codex":
      return [
        { where: "prefs.mcp.where.codex", language: "toml", code: [`[mcp_servers.ai-router]`, `url = "${url}"`, `bearer_token_env_var = "${v}"`].join("\n") },
        { where: "prefs.mcp.where.codexCli", language: "bash", code: `codex mcp add ai-router --url ${url} --bearer-token-env-var ${v}` },
      ];
    case "cursor":
      return [{ where: "prefs.mcp.where.cursor", language: "json", code: JSON.stringify({ mcpServers: { "ai-router": { url, headers: { Authorization: `Bearer \${env:${v}}` } } } }, null, 2) }];
    case "other":
      return [{ where: "prefs.mcp.where.other", language: "text", code: [`URL: ${url}`, "Transport: Streamable HTTP", "Authorization: Bearer <MCP token>"].join("\n") }];
  }
}

/** The line that puts a token in the environment (a placeholder until one is made). */
export const exportLine = (token: string) => `export ${MCP_TOKEN_VAR}=${token}`;

// ---- Groups and levels ---------------------------------------------------------------------------------------------

/** Same groups and levels as worker/mcp-tokens.ts. Usage has nothing to change: read at most. */
export const GROUPS = ["combos", "models", "systems", "connections", "usage", "settings"] as const;
export type Group = (typeof GROUPS)[number];
export type Level = "none" | "read" | "write";
export type Scopes = Record<Group, Level>;
const READ_ONLY: ReadonlySet<Group> = new Set(["usage"]);
const EXPIRY = ["7", "30", "90", "never"] as const;

/** The tools of each group (worker/mcp.ts), for the "what a token can do" table. */
export const GROUP_TOOLS: Record<Group, { read: string[]; change: string[] }> = {
  combos: { read: ["list_combos"], change: ["save_combo", "delete_combo", "set_combo_settings"] },
  models: { read: ["list_models", "list_aliases", "test_model"], change: ["disable_models", "enable_models", "set_alias", "delete_alias", "add_custom_model", "remove_custom_model", "set_thinking_mode"] },
  systems: { read: ["list_systems"], change: ["update_system"] },
  connections: { read: ["list_providers", "list_connections", "test_connection", "get_quota", "list_custom_providers"], change: ["update_connection", "reorder_connections", "set_provider_strategy"] },
  usage: { read: ["usage_summary", "usage_requests", "usage_by_month", "get_logs"], change: [] },
  settings: { read: ["get_settings", "list_pricing"], change: ["set_token_saver", "set_timeouts", "set_price", "delete_price"] },
};

export interface McpToken {
  id: string;
  name: string;
  hint: string;
  scopes: Scopes;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

const preset = (level: Level): Scopes => Object.fromEntries(GROUPS.map((g) => [g, level === "write" && READ_ONLY.has(g) ? "read" : level])) as Scopes;

/** "Combos: Read and change · Usage: Read", or "Status only". */
export function scopeSummary(s: Scopes): string {
  const parts = GROUPS.filter((g) => s[g] !== "none").map((g) => `${t(`mcp.group.${g}` as StringKey)}: ${t(`mcp.level.${s[g]}` as StringKey)}`);
  return parts.length ? parts.join(" · ") : t("mcp.noAccess");
}

const formatDate = (at: number, lang: Lang) => new Date(at * 1000).toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US", { year: "numeric", month: "short", day: "numeric" });

const MCP_CLIENTS: { value: McpClient; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "other", label: "" },
];

function ClientPicker({ client, onChange }: { client: McpClient; onChange: (c: McpClient) => void }) {
  return (
    <div className="mcp-clients">
      <Segmented label={t("prefs.mcpClient")} options={MCP_CLIENTS.map((c) => ({ value: c.value, label: c.label || t("prefs.mcp.other") }))} value={client} onChange={(v) => onChange(v as McpClient)} />
    </div>
  );
}

function Snippets({ client }: { client: McpClient }) {
  const [lang] = useLang();
  return (
    <>
      {mcpSnippets(client, window.location.origin).map((s, i) => (
        <Stack key={i} gap={1}>
          <span className="muted">{t(s.where)}</span>
          <CodeBlock code={s.code} language={s.language} labels={ui(lang).codeBlock} />
        </Stack>
      ))}
    </>
  );
}

// ---- The page ------------------------------------------------------------------------------------------------------

type Pending = { kind: "create" } | { kind: "edit"; token: McpToken } | { kind: "revoke"; token: McpToken } | { kind: "shown"; name: string; token: string };

/** MCP: connect an AI client in three steps, its tokens, and what each group lets it do. */
export function Mcp() {
  const [lang] = useLang();
  const labels = ui(lang);
  const notify = useNotify();
  const [tokens, reload] = useLoad<McpToken[]>("/mcp-tokens");
  const [client, setClient] = useState<McpClient>("claude");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const now = Date.now() / 1000;

  const close = () => {
    setPending(null);
    setDialogError(null);
  };
  const create = () => setPending({ kind: "create" });

  async function revoke(token: McpToken) {
    setBusy(true);
    setDialogError(null);
    try {
      await api(`/mcp-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      notify(t("mcp.revoked", { name: token.name }));
      close();
      reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setDialogError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const columns: DataTableColumn<McpToken>[] = [
    {
      key: "name",
      header: t("mcp.col.name"),
      cell: (x) => (
        <Stack gap={0}>
          <span>{x.name}</span>
          <span className="muted">…{x.hint}</span>
        </Stack>
      ),
    },
    { key: "access", header: t("mcp.col.access"), cell: (x) => scopeSummary(x.scopes) },
    {
      key: "expires",
      header: t("mcp.col.expires"),
      cell: (x) =>
        x.expires_at !== null && x.expires_at <= now ? (
          <StatusDot tone="neutral" label={t("mcp.expired")} />
        ) : (
          <StatusDot tone="ok" label={x.expires_at === null ? t("mcp.noExpiry") : formatDate(x.expires_at, lang)} />
        ),
    },
    { key: "used", header: t("mcp.col.used"), hideNarrow: true, cell: (x) => (x.last_used_at === null ? t("mcp.neverUsed") : formatAgo(x.last_used_at, lang)) },
    {
      key: "actions",
      header: <span className="x-sr-only">{t("mcp.col.actions")}</span>,
      width: "min",
      cell: (x) => (
        <MenuButton
          variant="icon"
          align="end"
          label={`${t("mcp.col.actions")}: ${x.name}`}
          items={[
            { label: t("mcp.edit"), onSelect: () => setPending({ kind: "edit", token: x }) },
            { type: "separator" },
            { label: t("mcp.revoke"), danger: true, onSelect: () => setPending({ kind: "revoke", token: x }) },
          ]}
        />
      ),
    },
  ];

  const canDo: DataTableColumn<Group>[] = [
    {
      key: "group",
      header: t("mcp.col.group"),
      cell: (g) => (
        <Stack gap={0}>
          <span>{t(`mcp.group.${g}` as StringKey)}</span>
          <span className="muted">{t(`mcp.groupHint.${g}` as StringKey)}</span>
        </Stack>
      ),
    },
    { key: "read", header: t("mcp.level.read"), cell: (g) => <code className="mcp-tools">{GROUP_TOOLS[g].read.join(", ")}</code> },
    { key: "change", header: t("mcp.level.write"), cell: (g) => (GROUP_TOOLS[g].change.length ? <code className="mcp-tools">{GROUP_TOOLS[g].change.join(", ")}</code> : <span className="muted">—</span>) },
  ];

  return (
    <Stack gap={4}>
      <Card title={t("mcp.steps")} headingLevel={2}>
        <ol className="mcp-steps">
          <li>
            <Stack gap={2}>
              <h3 className="mcp-step-title">{t("mcp.step1")}</h3>
              <span className="muted">{t("mcp.step1Body")}</span>
              <div>
                <Button variant="primary" icon="plus" onClick={create}>
                  {t("mcp.add")}
                </Button>
              </div>
            </Stack>
          </li>
          <li>
            <Stack gap={2}>
              <h3 className="mcp-step-title">{t("mcp.step2")}</h3>
              <span className="muted">{t("mcp.step2Body", { name: MCP_TOKEN_VAR })}</span>
              <CodeBlock code={exportLine(t("mcp.placeholder"))} language="bash" labels={labels.codeBlock} />
            </Stack>
          </li>
          <li>
            <Stack gap={2}>
              <h3 className="mcp-step-title">{t("mcp.step3")}</h3>
              <span className="muted">{t("mcp.step3Body")}</span>
              <ClientPicker client={client} onChange={setClient} />
              <Snippets client={client} />
            </Stack>
          </li>
        </ol>
      </Card>

      <Card title={t("mcp.tokensTitle")} subtitle={t("mcp.tokensHint")} headingLevel={2} flush>
        {tokens.status === "loading" && <Skeleton lines={2} announce labels={{ loading: t("loading") }} />}
        {tokens.status === "error" && <Banner tone="danger" title={t("error.load")} action={<Button onClick={reload}>{t("common.retry")}</Button>} />}
        {tokens.status === "ready" && (
          <DataTable
            caption={t("mcp.caption")}
            columns={columns}
            rows={tokens.data}
            rowKey={(x) => x.id}
            labels={labels.dataTable}
            empty={
              <EmptyState
                size="center"
                icon="bot"
                title={t("mcp.empty")}
                actions={
                  <Button icon="plus" onClick={create}>
                    {t("mcp.add")}
                  </Button>
                }
              />
            }
          />
        )}
      </Card>

      <Card title={t("mcp.canDo")} subtitle={t("mcp.canDoHint")} headingLevel={2} flush>
        <DataTable caption={t("mcp.canDo")} columns={canDo} rows={[...GROUPS]} rowKey={(g) => g} labels={labels.dataTable} empty={<EmptyState size="center" icon="bot" title={t("mcp.noAccess")} />} />
      </Card>

      {(pending?.kind === "create" || pending?.kind === "edit") && (
        <TokenForm
          token={pending.kind === "edit" ? pending.token : null}
          onCancel={close}
          onDone={(r) => {
            reload();
            if (r.token) setPending({ kind: "shown", name: r.name, token: r.token });
            else {
              notify(t("mcp.saved", { name: r.name }));
              close();
            }
          }}
        />
      )}
      {pending?.kind === "revoke" && (
        <Dialog
          modal
          alert
          tone="danger"
          title={t("mcp.revokeTitle", { name: pending.token.name })}
          labels={labels.dialog}
          confirmLabel={t("mcp.revoke")}
          busy={busy}
          onCancel={close}
          onConfirm={() => void revoke(pending.token)}
        >
          <Stack gap={2}>
            <span>{t("mcp.revokeBody")}</span>
            {dialogError && <Banner tone="danger" title={dialogError} />}
          </Stack>
        </Dialog>
      )}
      {pending?.kind === "shown" && (
        <Dialog modal size="wide" body="plain" title={t("mcp.shownTitle", { name: pending.name })} confirmLabel={t("common.close")} cancelLabel={null} labels={labels.dialog} onConfirm={close} onCancel={close}>
          <Stack gap={3}>
            <Banner tone="warn" title={t("token.once")} />
            <h3 className="dialog-subheading">{t("mcp.step2")}</h3>
            <CodeBlock code={exportLine(pending.token)} language="bash" labels={labels.codeBlock} />
            <h3 className="dialog-subheading">{t("mcp.step3")}</h3>
            <ClientPicker client={client} onChange={setClient} />
            <Snippets client={client} />
          </Stack>
        </Dialog>
      )}
    </Stack>
  );
}

/** Create (name, expiry, levels) or edit (name, levels) a token. Create answers with the token, once. */
function TokenForm({ token, onCancel, onDone }: { token: McpToken | null; onCancel: () => void; onDone: (r: { name: string; token?: string }) => void }) {
  const [lang] = useLang();
  const [name, setName] = useState(token?.name ?? "");
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>("90");
  const [scopes, setScopes] = useState<Scopes>(token?.scopes ?? preset("read"));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = name.trim() !== "" && name.length <= 100;

  async function submit() {
    setTried(true);
    if (!nameOk) return;
    setBusy(true);
    setError(null);
    try {
      if (token) {
        await api(`/mcp-tokens/${encodeURIComponent(token.id)}`, { method: "PATCH", body: { name: name.trim(), scopes } });
        onDone({ name: name.trim() });
      } else {
        const r = await api<{ name: string; token: string }>("/mcp-tokens", { body: { name: name.trim(), scopes, expires_days: expiry === "never" ? null : Number(expiry) } });
        onDone({ name: r.name, token: r.token });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof ApiError && e.status === 400 ? t("create.badInput") : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const levels = (g: Group) =>
    (READ_ONLY.has(g) ? (["none", "read"] as const) : (["none", "read", "write"] as const)).map((l) => ({ value: l, label: t(`mcp.level.${l}` as StringKey) }));

  return (
    <FormDialog
      title={token ? t("mcp.editTitle", { name: token.name }) : t("mcp.addTitle")}
      description={t("mcp.formHint")}
      submitLabel={token ? t("common.save") : t("mcp.create")}
      labels={ui(lang).formDialog}
      busy={busy}
      error={error ?? undefined}
      onCancel={onCancel}
      onSubmit={() => void submit()}
    >
      <Field label={t("mcp.name")} hint={t("mcp.nameHint")} value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} error={tried && !nameOk ? t("ux.systems.nameBad") : undefined} />
      {!token && (
        <SettingRow
          label={t("mcp.expiry")}
          controlId="mcp-expiry"
          control={
            <Select
              id="mcp-expiry"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as (typeof EXPIRY)[number])}
              options={EXPIRY.map((x) => ({ value: x, label: x === "never" ? t("mcp.noExpiry") : t("mcp.days", { n: x }) }))}
            />
          }
        />
      )}
      <Stack gap={2}>
        <span className="muted">{t("mcp.levels")}</span>
        <div className="page-actions">
          <Button onClick={() => setScopes(preset("read"))}>{t("mcp.presetRead")}</Button>
          <Button onClick={() => setScopes(preset("write"))}>{t("mcp.presetAll")}</Button>
          <Button onClick={() => setScopes(preset("none"))}>{t("mcp.presetNone")}</Button>
        </div>
        {GROUPS.map((g) => (
          <SettingRow
            key={g}
            label={t(`mcp.group.${g}` as StringKey)}
            description={t(`mcp.groupHint.${g}` as StringKey)}
            controlId={`mcp-level-${g}`}
            control={<Select id={`mcp-level-${g}`} value={scopes[g]} onChange={(e) => setScopes({ ...scopes, [g]: e.target.value as Level })} options={levels(g)} />}
          />
        ))}
      </Stack>
    </FormDialog>
  );
}
