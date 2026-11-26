// First run in Docker: makes the secrets a fresh stack needs, in the `secrets` volume, once.
//
//   gateway.json   CONNECTIONS_KEY, ADMIN_TOKEN_SHA256, CODEX_RELAY_URL, CODEX_RELAY_SECRET: defaults for the gateway
//                  (start.mjs); a value set in .dev.vars wins
//   relay-secret   the Codex relay's RELAY_SECRET (RELAY_SECRET_FILE); .codex-relay.env wins
//   admin-token    the owner's admin token for the console; only its SHA-256 goes to the gateway
//   studio-secret  the studio's STUDIO_SECRET (STUDIO_SECRET_FILE); the gateway gets it as STUDIO_SECRET with
//                  STUDIO_URL. Added to an older stack's volume too, as is studio-channels-key
//   studio-channels-key  the studio's CHANNELS_KEY (CHANNELS_KEY_FILE): seals the channels' credentials
//
// Nothing here is printed: read the token with `docker compose exec ai-router cat /secrets/admin-token`.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const random = () => randomBytes(32).toString("base64url");

/** Writes the files unless gateway.json is already there; the studio's are added on their own when missing. */
export function ensureSecrets(dir) {
  const gateway = join(dir, "gateway.json");
  if (existsSync(gateway)) return { created: false, studio: ensureStudio(dir) };
  mkdirSync(dir, { recursive: true });
  const token = random();
  const relay = random();
  const write = (name, text) => writeFileSync(join(dir, name), text, { mode: 0o600 });
  write("admin-token", token);
  write("relay-secret", relay);
  // Last, so a run cut short is redone in full.
  write(
    "gateway.json",
    JSON.stringify(
      {
        CONNECTIONS_KEY: randomBytes(32).toString("base64"),
        ADMIN_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
        CODEX_RELAY_URL: "http://codex-relay:8790",
        CODEX_RELAY_SECRET: relay,
      },
      null,
      2,
    ),
  );
  return { created: true, studio: ensureStudio(dir) };
}

/** The studio's secret and channels key, and the gateway's STUDIO_URL and STUDIO_SECRET, once. */
export function ensureStudio(dir) {
  const file = join(dir, "studio-secret");
  if (existsSync(file)) return false;
  const secret = random();
  const write = (name, text) => writeFileSync(join(dir, name), text, { mode: 0o600 });
  if (!existsSync(join(dir, "studio-channels-key"))) write("studio-channels-key", randomBytes(32).toString("base64"));
  const gateway = join(dir, "gateway.json");
  const env = JSON.parse(readFileSync(gateway, "utf8"));
  write("gateway.json", JSON.stringify({ ...env, STUDIO_URL: "http://studio:8791", STUDIO_SECRET: secret }, null, 2));
  // Last, so a run cut short is redone.
  write("studio-secret", secret);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? "/secrets";
  const { created, studio } = ensureSecrets(dir);
  if (!created && studio) console.log(`studio secrets added in ${dir}`);
  console.log(
    created
      ? `secrets made in ${dir}. Admin token: docker compose exec ai-router cat ${dir}/admin-token`
      : `secrets already in ${dir}`,
  );
}
