import { serve } from "@hono/node-server";
import { join } from "node:path";
import { AiRouter } from "./ai-router.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { Queue } from "./queue.ts";
import { createApp, loadSettings } from "./server.ts";

const config = loadConfig();
const store = new Store(join(config.dataDir, "clip-studio.db"));
const ai = new AiRouter({ baseUrl: config.aiRouterUrl, token: config.aiRouterToken });
loadSettings(store, config, ai);
const log = (m: string) => console.log(new Date().toISOString(), m);
const queue = new Queue({ store, ai, dataDir: config.dataDir, subtitleFont: config.subtitleFont, fontsDir: config.fontsDir, channelsKey: config.channelsKey, publicBaseUrl: config.publicBaseUrl, log });
const app = createApp({ store, ai, config, kick: () => void queue.tick(), applySettings: (s) => queue.setPublicBaseUrl(s.publicBaseUrl) });

queue.start();
serve({ fetch: app.fetch, port: config.port }, (i) => log(`clip-studio on http://localhost:${i.port}, ai-router ${config.aiRouterUrl}`));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (queue.stop(), process.exit(0)));
