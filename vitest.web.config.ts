import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The build this console comes from: the commit in CI's image (Dockerfile), `dev` anywhere else (web/version.ts).
const version = process.env.APP_VERSION?.trim() || "dev";

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  test: {
    environment: "jsdom",
    // Node 25+ has its own global localStorage (undefined without --localstorage-file), which hides jsdom's.
    execArgv: ["--no-experimental-webstorage"],
    include: ["web/test/**/*.test.{ts,tsx}"],
    // Tests read web/styles.css and the IBM Plex Sans weights as text (?raw) to check what a DOM without layout or fonts
    // cannot measure; nothing is injected.
    css: { include: [/styles\.css\?raw$/, /@fontsource\/ibm-plex-sans\/\d+\.css\?raw$/] },
  },
});
