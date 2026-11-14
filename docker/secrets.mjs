// First run in Docker: makes the secrets a fresh stack needs, in the `secrets` volume, once.
//
//   gateway.json   CONNECTIONS_KEY, ADMIN_TOKEN_SHA256, CODEX_RELAY_URL, CODEX_RELAY_SECRET: defaults for the gateway
//                  (start.mjs); a value set in .dev.vars wins
//   relay-secret   the Codex relay's RELAY_SECRET (RELAY_SECRET_FILE); .codex-relay.env wins
//   admin-token    the owner's admin token for the console; only its SHA-256 goes to the gateway
//
// Nothing here is printed: read the token with `docker compose exec ai-router cat /secrets/admin-token`.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const random = () => randomBytes(32).toString("base64url");

/** Writes the three files unless gateway.json is already there. */
export function ensureSecrets(dir) {
  const gateway = join(dir, "gateway.json");
  if (existsSync(gateway)) return { created: false };
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
  return { created: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? "/secrets";
  const { created } = ensureSecrets(dir);
  console.log(
    created
      ? `secrets made in ${dir}. Admin token: docker compose exec ai-router cat ${dir}/admin-token`
      : `secrets already in ${dir}`,
  );
}
