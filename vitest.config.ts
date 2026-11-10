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
            ADMIN_TOKEN_SHA256: await sha256hex(TEST_ADMIN_TOKEN),
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
