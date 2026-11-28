import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call, fakeUpstream, reset } from "./helpers";
import { SECURITY_HEADERS } from "../app";

// Every response the Worker returns carries the security headers (app.ts). The console's static assets get the
// same set from dist/_headers (web/public/_headers), which the asset layer serves and tests here cannot reach.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(reset);

describe("security headers", () => {
  const expectHeaders = (res: Response) => {
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  };

  it("names only framing, sniffing, referrer and transport — nothing that limits cross-origin reads", () => {
    // CORP/COOP/COEP would break the gateway's cross-origin SDK use, so they are not here.
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual(["Content-Security-Policy", "Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options"]);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
  });

  it("are on a plain Worker response (health, no token)", async () => {
    const { res } = await call(fakeUpstream(() => json({})), "/health");
    expect(res.status).toBe(200);
    expectHeaders(res);
  });

  it("are on an error from a sub-app (gateway without a token)", async () => {
    const { res } = await call(fakeUpstream(() => json({})), "/openai/v1/models");
    expect(res.status).toBe(401);
    expectHeaders(res);
  });

  it("are on an admin response, next to its own headers", async () => {
    const { res } = await call(fakeUpstream(() => json({})), "/admin/quota", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(res.status).toBe(200);
    expectHeaders(res);
  });

  it("do not disturb CORS on the gateway surface", async () => {
    const { res } = await call(fakeUpstream(() => json({})), "/v1/models", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expectHeaders(res);
  });

  it("are on a passed-through upstream response (whose headers may be immutable)", async () => {
    const token = (async () => {
      const r = await call(fakeUpstream(() => json({})), "/admin/connections", { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "openai", name: "k", api_key: "sk-test-headers-0001" }) });
      expect(r.res.status, r.text).toBe(201);
    })();
    await token;
    const up = fakeUpstream(() => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const { res } = await call(up, "/openai/v1/models", { headers: { authorization: "Bearer gw_nope" } });
    // Even a 401 before upstream carries them; the point is the chain never drops them.
    expectHeaders(res);
  });
});
