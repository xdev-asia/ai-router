import { mkdirSync } from "node:fs";
mkdirSync(new URL("../dist", import.meta.url), { recursive: true });
