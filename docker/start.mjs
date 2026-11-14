// Starts the gateway in Docker: applies the D1 migrations, then `wrangler dev` on 0.0.0.0:8787.
//
// wrangler dev reads the Worker's secrets from /app/.dev.vars. This writes that file from the container's env
// (compose passes the host's .dev.vars as env_file) and, for what is unset there, the first-run defaults in
// /secrets/gateway.json (secrets.mjs). Only the names declared in worker/env.ts are written, so PATH, HOME and
// the like stay out of the Worker.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The string bindings of `interface Env` in worker/env.ts. */
export function envNames(source) {
  const body = source.match(/interface Env \{([\s\S]*?)\n\}/)?.[1] ?? "";
  return [...body.matchAll(/^\s+([A-Z][A-Z0-9_]*)\??:\s*string;/gm)].map((m) => m[1]);
}

/** For each name: the container's value, else the generated default. Empty counts as unset. */
export function workerEnv(names, env, defaults) {
  const out = {};
  for (const name of names) {
    const value = env[name] || defaults[name];
    if (value) out[name] = value;
  }
  return out;
}

/** dotenv text, each value quoted with a quote character it does not contain (single quotes: taken literally). */
export function devVars(vars) {
  return Object.entries(vars)
    .map(([name, value]) => {
      const q = ["'", '"', "`"].find((c) => !value.includes(c)) ?? "'";
      return `${name}=${q}${value}${q}\n`;
    })
    .join("");
}

const WRANGLER = "node_modules/wrangler/bin/wrangler.js";

// wrangler dev takes request.url's host from the route in wrangler.jsonc (ai-router.xdev.asia) but keeps http; behind
// the Cloudflare Tunnel the browser is on https, and the console's sign-in redirect is built from that origin.
export const SERVE_ARGS = ["dev", "--ip", "0.0.0.0", "--port", "8787", "--upstream-protocol", "https"];

const run = (args) => {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** Runs wrangler and passes `docker stop`'s SIGTERM on to it (this script is PID 1). */
const serve = (args) => {
  const child = spawn(process.execPath, [WRANGLER, ...args], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const generated = "/secrets/gateway.json";
  const defaults = existsSync(generated) ? JSON.parse(readFileSync(generated, "utf8")) : {};
  const names = envNames(readFileSync("worker/env.ts", "utf8"));
  writeFileSync(".dev.vars", devVars(workerEnv(names, process.env, defaults)), { mode: 0o600 });
  run(["d1", "migrations", "apply", "xdev-llm", "--local"]);
  serve(SERVE_ARGS);
}
