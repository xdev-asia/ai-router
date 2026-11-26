import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Fake values only. Never real keys. Same value as ADMIN_TOKEN in worker/test/helpers.ts.
const TEST_ADMIN_TOKEN = "test-admin-token";

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("./migrations");
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // pool-workers 0.23 bundles workerd 2026-08-22, older than wrangler.jsonc compatibility_date
          compatibilityDate: "2026-08-22",
          bindings: {
            TEST_MIGRATIONS: migrations,
            ANTHROPIC_BASE_URL: "https://upstream.test",
            ANTHROPIC_KEYS: JSON.stringify({ chat: "sk-ant-test-chat", xdevd: "sk-ant-test-xdevd", off: "sk-ant-test-off", capped: "sk-ant-test-capped" }),
            // deepseek left out on purpose (not_configured case).
            PROVIDER_KEYS: JSON.stringify({ openai: "sk-test-openai", groq: "gsk-test-groq", openrouter: "sk-or-test", gemini: "g-test" }),
            ADMIN_TOKEN_SHA256: await sha256hex(TEST_ADMIN_TOKEN),
            // 32 bytes, base64. Seals the connections' credentials in the test database.
            CONNECTIONS_KEY: "dGVzdC1jb25uZWN0aW9ucy1rZXktMzItYnl0ZXMtISE=",
            // Fake xDev ID (see worker/test/console-auth.test.ts).
            OIDC_ISSUER: "https://id.test/api/auth",
            OIDC_CLIENT_ID: "llm-client",
            OIDC_CLIENT_SECRET: "test-oidc-secret",
            CONSOLE_EMAILS: "owner@example.com, second@example.com",
            // .dev.vars is read too: keep a local relay out of the tests (worker/test/codex.test.ts sets its own).
            CODEX_RELAY_URL: "",
            CODEX_RELAY_SECRET: "",
            // The same for a local studio (worker/test/studio.test.ts sets its own).
            STUDIO_URL: "",
            STUDIO_SECRET: "",
          },
        },
      };
    }),
  ],
  test: {
    include: ["worker/test/**/*.test.ts"],
    setupFiles: ["./worker/test/apply-migrations.ts"],
  },
});
