// Tests for the Docker helpers: first-run secrets and the .dev.vars wrangler reads. Fake values only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ensureSecrets } from "../secrets.mjs";
import { SERVE_ARGS, devVars, envNames, workerEnv } from "../start.mjs";

describe("first-run secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-router-secrets-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the gateway's defaults, the relay secret and the admin token once", () => {
    const first = ensureSecrets(dir);
    assert.equal(first.created, true);
    const env = JSON.parse(readFileSync(join(dir, "gateway.json"), "utf8"));
    const relay = readFileSync(join(dir, "relay-secret"), "utf8");
    const token = readFileSync(join(dir, "admin-token"), "utf8");

    assert.equal(Buffer.from(env.CONNECTIONS_KEY, "base64").length, 32);
    assert.ok(relay.length >= 32);
    assert.equal(env.CODEX_RELAY_SECRET, relay);
    assert.equal(env.CODEX_RELAY_URL, "http://codex-relay:8790");
    assert.equal(env.ADMIN_TOKEN_SHA256, createHash("sha256").update(token).digest("hex"));
    assert.ok(!JSON.stringify(env).includes(token), "the token itself is not in the gateway's env");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "admin-token")).mode & 0o077, 0);

    const second = ensureSecrets(dir);
    assert.equal(second.created, false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "gateway.json"), "utf8")), env, "kept on later runs");
  });

  it("gives the studio its secret and channels key, and the gateway STUDIO_URL and STUDIO_SECRET", () => {
    const env = JSON.parse(readFileSync(join(dir, "gateway.json"), "utf8"));
    const studio = readFileSync(join(dir, "studio-secret"), "utf8");
    assert.ok(studio.length >= 32);
    assert.equal(env.STUDIO_SECRET, studio);
    assert.equal(env.STUDIO_URL, "http://studio:8791");
    assert.equal(Buffer.from(readFileSync(join(dir, "studio-channels-key"), "utf8"), "base64").length, 32);
  });
});

describe("an older stack's secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-router-secrets-old-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("gets the studio's secrets added once, keeping what was there", () => {
    const old = { CONNECTIONS_KEY: "kept", ADMIN_TOKEN_SHA256: "kept", CODEX_RELAY_URL: "http://codex-relay:8790", CODEX_RELAY_SECRET: "kept" };
    writeFileSync(join(dir, "gateway.json"), JSON.stringify(old));
    const first = ensureSecrets(dir);
    assert.deepEqual(first, { created: false, studio: true });
    const env = JSON.parse(readFileSync(join(dir, "gateway.json"), "utf8"));
    assert.equal(env.CONNECTIONS_KEY, "kept");
    assert.equal(env.STUDIO_SECRET, readFileSync(join(dir, "studio-secret"), "utf8"));
    assert.deepEqual(ensureSecrets(dir), { created: false, studio: false });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "gateway.json"), "utf8")), env);
  });
});

describe("worker env", () => {
  const source = `export interface Env {
  DB: D1Database;
  ANTHROPIC_BASE_URL: string;
  /** Secret. */
  CONNECTIONS_KEY?: string;
  GOOGLE_GEMINI_CLI_CLIENT_ID?: string;
}
export type AppEnv = { Bindings: Env; Variables: { startedAt: number } };`;

  it("names the string bindings of Env", () => {
    assert.deepEqual(envNames(source), ["ANTHROPIC_BASE_URL", "CONNECTIONS_KEY", "GOOGLE_GEMINI_CLI_CLIENT_ID"]);
  });

  it("passes the image's build (APP_VERSION, APP_BUILT_AT) on to the Worker", () => {
    const names = envNames(readFileSync(new URL("../../worker/env.ts", import.meta.url), "utf8"));
    assert.ok(names.includes("APP_VERSION") && names.includes("APP_BUILT_AT"));
  });

  it("takes the container's env first, then the generated defaults, and nothing else", () => {
    const names = ["CONNECTIONS_KEY", "CODEX_RELAY_URL", "ANTHROPIC_KEYS"];
    const env = workerEnv(names, { CONNECTIONS_KEY: "from-dev-vars", PATH: "/usr/bin", ANTHROPIC_KEYS: "" }, {
      CONNECTIONS_KEY: "generated",
      CODEX_RELAY_URL: "http://codex-relay:8790",
    });
    assert.deepEqual(env, { CONNECTIONS_KEY: "from-dev-vars", CODEX_RELAY_URL: "http://codex-relay:8790" });
  });

  it("quotes each value so JSON and = survive", () => {
    const text = devVars({ ANTHROPIC_KEYS: '{"chat":"sk-ant-fake"}', CONNECTIONS_KEY: "abc==", ODD: `it's "x"` });
    assert.equal(text, `ANTHROPIC_KEYS='{"chat":"sk-ant-fake"}'\nCONNECTIONS_KEY='abc=='\nODD=\`it's "x"\`\n`);
  });
});

describe("build version", () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  it("CI hands the commit and build time to the image", () => {
    const ci = read(".github/workflows/ci.yml");
    assert.match(ci, /APP_VERSION=\$\{\{ github\.sha \}\}/);
    assert.match(ci, /APP_BUILT_AT=/);
  });

  it("the image keeps them for the console build and the Worker", () => {
    const stages = read("Dockerfile").split(/^FROM /m).slice(1);
    const build = stages.find((s) => s.includes("AS console-build"));
    const final = stages.at(-1);
    for (const stage of [build, final]) assert.match(stage, /ARG APP_VERSION=dev/);
    assert.match(build, /ENV APP_VERSION=\$APP_VERSION/);
    assert.match(final, /ENV APP_VERSION=\$APP_VERSION APP_BUILT_AT=\$APP_BUILT_AT/);
  });
});

describe("package source", () => {
  const stage = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8")
    .split(/^FROM /m)
    .find((s) => s.includes("AS console-build"));
  const install = stage.match(/^RUN [^\n]*(?:\\\n[^\n]*)*pnpm install[^\n]*/m)?.[0];

  // @xdev-asia/ui is on npmjs.com: the console build takes no token, no secret and no registry mapping.
  it("installs from npmjs.com without a token", () => {
    assert.ok(install, "console-build has a pnpm install step");
    assert.match(install, /corepack pnpm install --frozen-lockfile/);
    assert.doesNotMatch(stage, /secret|_authToken|\.npmrc|npm\.pkg\.github\.com/);
  });

  it("the lockfile takes @xdev-asia/ui from npmjs.com", () => {
    const lock = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
    assert.doesNotMatch(lock, /npm\.pkg\.github\.com/);
  });
});

describe("public domain through a Cloudflare Tunnel", () => {
  const compose = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");
  const tunnel = compose.match(/^  cloudflared:\n(?:(?: {4}.*)?\n)+/m)?.[0];

  // The tunnel speaks https to the browser and plain http to the container; the Worker builds its own links and the
  // console's sign-in redirect from request.url, so wrangler dev must report https.
  it("wrangler dev tells the Worker the public origin is https", () => {
    assert.deepEqual(SERVE_ARGS, ["dev", "--ip", "0.0.0.0", "--port", "8787", "--upstream-protocol", "https"]);
  });

  it("compose runs cloudflared only with the tunnel profile, on a token from the environment", () => {
    assert.ok(tunnel, "compose.yaml has a cloudflared service");
    assert.match(tunnel, /profiles: \["tunnel"\]/);
    assert.match(tunnel, /command: \["tunnel", "--no-autoupdate", "run"\]/);
    assert.match(tunnel, /TUNNEL_TOKEN: \$\{TUNNEL_TOKEN:-\}/);
    assert.match(tunnel, /restart: unless-stopped/);
    assert.doesNotMatch(tunnel, /ports:/, "the tunnel dials out; nothing listens on the host");
  });
});
