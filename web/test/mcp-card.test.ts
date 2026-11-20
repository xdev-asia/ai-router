import { describe, expect, it } from "vitest";
import { MCP_TOKEN_VAR, mcpSnippets, type McpClient } from "../pages/Mcp";

describe("MCP snippets", () => {
  it("point every client at /mcp and read the token from the environment, never a literal", () => {
    for (const client of ["claude", "codex", "cursor", "other"] as McpClient[]) {
      const code = mcpSnippets(client, "https://gw.example/").map((s) => s.code).join("\n");
      expect(code, client).toContain("https://gw.example/mcp");
      expect(code, client).not.toContain("gw.example//mcp");
    }
  });

  it("use each client's own variable syntax", () => {
    const claude = JSON.parse(mcpSnippets("claude", "https://gw.example")[0]!.code);
    expect(claude.mcpServers["ai-router"]).toEqual({ type: "http", url: "https://gw.example/mcp", headers: { Authorization: `Bearer \${${MCP_TOKEN_VAR}}` } });
    const cursor = JSON.parse(mcpSnippets("cursor", "https://gw.example")[0]!.code);
    expect(cursor.mcpServers["ai-router"].headers.Authorization).toBe(`Bearer \${env:${MCP_TOKEN_VAR}}`);
    const [toml, cli] = mcpSnippets("codex", "https://gw.example");
    expect(toml!.code).toBe(`[mcp_servers.ai-router]\nurl = "https://gw.example/mcp"\nbearer_token_env_var = "${MCP_TOKEN_VAR}"`);
    expect(cli!.code).toBe(`codex mcp add ai-router --url https://gw.example/mcp --bearer-token-env-var ${MCP_TOKEN_VAR}`);
  });
});
