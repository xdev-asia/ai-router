import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call, fakeUpstream, reset } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const STUDIO = { STUDIO_URL: "http://studio.test:8791", STUDIO_SECRET: "fake-studio-secret-for-tests" };
const admin = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

beforeEach(reset);

describe("Clip Studio through the console", () => {
  it("says it is not set up without STUDIO_URL and STUDIO_SECRET, and calls nothing", async () => {
    const up = fakeUpstream(() => json({}));
    const status = await call(up, "/admin/studio/status", admin());
    expect(JSON.parse(status.text)).toMatchObject({ configured: false });
    expect((await call(up, "/admin/studio/api/projects", admin())).res.status).toBe(503);
    expect((await call(up, "/admin/studio/connect", admin({ method: "POST" }))).res.status).toBe(503);
    expect(up.calls).toHaveLength(0);
  });

  it("passes /admin/studio/api/* on with the shared secret, never handing the secret back", async () => {
    const up = fakeUpstream(() => json({ projects: [] }));
    const { res, text } = await call(up, "/admin/studio/api/projects?x=1", admin({ method: "POST", body: JSON.stringify({ topic: "t" }) }), STUDIO);
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ projects: [] });
    expect(up.calls[0]!.url).toBe("http://studio.test:8791/api/projects?x=1");
    expect(up.calls[0]!.method).toBe("POST");
    expect(up.calls[0]!.headers.get("authorization")).toBe(`Bearer ${STUDIO.STUDIO_SECRET}`);
    // The console's own credentials stay here.
    expect(up.calls[0]!.headers.get("cookie")).toBeNull();
    expect(JSON.parse(up.bodies[0]!)).toEqual({ topic: "t" });
    expect(text).not.toContain(STUDIO.STUDIO_SECRET);
  });

  it("refuses the studio's API without console access", async () => {
    const up = fakeUpstream(() => json({}));
    expect((await call(up, "/admin/studio/api/projects", {}, STUDIO)).res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("connect makes the studio system, hands its token to the studio, and renews it the next time", async () => {
    const up = fakeUpstream(() => json({ has_token: true }));
    const first = await call(up, "/admin/studio/connect", admin({ method: "POST" }), STUDIO);
    expect(first.res.status).toBe(200);
    expect(JSON.parse(first.text)).toEqual({ connected: true, system: "studio", created: true });
    const sent = JSON.parse(up.bodies[0]!) as { ai_router_token: string; public_base_url: string };
    expect(up.calls[0]!.method).toBe("PUT");
    expect(up.calls[0]!.url).toBe("http://studio.test:8791/api/settings");
    expect(sent.public_base_url).toMatch(/\/studio$/);
    expect(first.text).not.toContain(sent.ai_router_token);
    const row = await env.DB.prepare("SELECT allowed_models FROM system WHERE id = 'studio'").first<{ allowed_models: string }>();
    expect(JSON.parse(row!.allowed_models)).toEqual(["*"]);

    // The token works as a gateway token.
    const models = await call(fakeUpstream(() => json({ data: [] })), "/v1/models", { headers: { authorization: `Bearer ${sent.ai_router_token}` } });
    expect(models.res.status).toBe(200);

    const second = await call(up, "/admin/studio/connect", admin({ method: "POST" }), STUDIO);
    expect(JSON.parse(second.text)).toMatchObject({ created: false });
    const renewed = JSON.parse(up.bodies[1]!).ai_router_token;
    expect(renewed).not.toBe(sent.ai_router_token);
    expect((await call(fakeUpstream(() => json({ data: [] })), "/v1/models", { headers: { authorization: `Bearer ${sent.ai_router_token}` } })).res.status).toBe(401);
  });

  it("serves a finished clip publicly, with Range, and nothing else under /studio/files", async () => {
    const up = fakeUpstream(() => new Response("part", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-3/100", "set-cookie": "x=y" } }));
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const { res, text } = await call(up, `/studio/files/${id}.mp4`, { headers: { range: "bytes=0-3" } }, STUDIO);
    expect(res.status).toBe(206);
    expect(text).toBe("part");
    expect(res.headers.get("content-range")).toBe("bytes 0-3/100");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(up.calls[0]!.url).toBe(`http://studio.test:8791/files/${id}.mp4`);
    expect(up.calls[0]!.headers.get("range")).toBe("bytes=0-3");
    expect(up.calls[0]!.headers.get("authorization")).toBeNull();
    expect((await call(up, "/studio/files/../api/projects", {}, STUDIO)).res.status).toBe(404);
    expect((await call(up, `/studio/files/${id}.mp3`, {}, STUDIO)).res.status).toBe(404);
    expect(up.calls).toHaveLength(1);
  });
});
