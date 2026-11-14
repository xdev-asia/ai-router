import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The build this console comes from: the commit in CI's image (Dockerfile), `dev` anywhere else (web/version.ts).
const version = process.env.APP_VERSION?.trim() || "dev";

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  test: {
    environment: "jsdom",
    include: ["web/test/**/*.test.{ts,tsx}"],
  },
});
