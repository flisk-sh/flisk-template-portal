import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortal, type GithubUser } from "../src/portal";

const BASE = "http://portal.test";
const ME: GithubUser = { id: 4242, login: "octocat", name: "Octo Cat", avatar_url: "https://example.com/a.png" };
let dir: string;
let upstreamCalls: Array<{ url: string; body: string | undefined }>;

function make(extra: Partial<Parameters<typeof createPortal>[0]> = {}) {
  upstreamCalls = [];
  return createPortal({
    publicUrl: BASE,
    upstreamUrl: "http://upstream.test",
    dataDir: dir,
    publicDir: join(import.meta.dir, "..", "public"),
    devLogin: async () => ME,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamCalls.push({ url: String(input), body: init?.body as string | undefined });
      return new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    ...extra,
  });
}
const req = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  new Request(BASE + path, { ...init, headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
async function login(portal: ReturnType<typeof make>) {
  const res = await portal.fetch(req("/auth/dev"));
  expect(res.status).toBe(302);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}
async function newKey(portal: ReturnType<typeof make>, cookie: string, name = "test") {
  const res = await portal.fetch(req("/api/keys", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
}
const chat = (key: string, body: unknown = { model: "m", messages: [] }) =>
  req("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "portal-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sign-in", () => {
  it("refuses the console API without a session", async () => {
    expect((await make().fetch(req("/api/me"))).status).toBe(401);
  });
  it("signs in through the local gh login and returns the GitHub profile", async () => {
    const p = make();
    const me = (await (await p.fetch(req("/api/me", { cookie: await login(p) }))).json()) as { login: string };
    expect(me.login).toBe("octocat");
  });
  it("has no dev login unless one is passed", async () => {
    expect((await make({ devLogin: undefined }).fetch(req("/auth/dev"))).status).toBe(403);
  });
  it("rejects a forged or tampered session cookie", async () => {
    const p = make();
    const cookie = await login(p);
    expect((await p.fetch(req("/api/me", { cookie: `${cookie}x` }))).status).toBe(401);
    expect((await p.fetch(req("/api/me", { cookie: "fi_session=e30.abc" }))).status).toBe(401);
  });
  it("starts the GitHub flow only when OAuth is configured, and rejects an unknown state", async () => {
    expect((await make().fetch(req("/auth/github"))).status).toBe(501);
    const p = make({ github: { clientId: "id", clientSecret: "secret" } });
    const start = await p.fetch(req("/auth/github"));
    expect(start.headers.get("location")).toContain("https://github.com/login/oauth/authorize?client_id=id");
    expect((await p.fetch(req("/auth/callback?state=nope&code=x"))).status).toBe(400);
  });
  it("completes the OAuth callback with a valid state", async () => {
    const calls: string[] = [];
    const p = make({
      github: { clientId: "id", clientSecret: "secret" },
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify(String(input).includes("access_token") ? { access_token: "tok" } : ME));
      }) as typeof fetch,
    });
    const state = new URL((await p.fetch(req("/auth/github"))).headers.get("location") ?? "").searchParams.get("state");
    const done = await p.fetch(req(`/auth/callback?state=${state}&code=abc`));
    expect(done.status).toBe(302);
    expect(done.headers.get("set-cookie")).toContain("fi_session=");
    expect(calls).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user"]);
    expect((await p.fetch(req(`/auth/callback?state=${state}&code=abc`))).status).toBe(400); // state is single use
  });
});

describe("API keys", () => {
  it("shows the key once and stores only its hash", async () => {
    const p = make();
    const cookie = await login(p);
    const { key } = await newKey(p, cookie);
    expect(key.startsWith("fi-")).toBe(true);
    const list = (await (await p.fetch(req("/api/keys", { cookie }))).json()) as Array<Record<string, string>>;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(key);
    expect(readFileSync(join(dir, "db.json"), "utf-8")).not.toContain(key);
  });
  it("revokes a key and then refuses it", async () => {
    const p = make();
    const cookie = await login(p);
    const { id, key } = await newKey(p, cookie);
    expect((await p.fetch(chat(key))).status).toBe(200);
    expect((await p.fetch(req(`/api/keys/${id}`, { method: "DELETE", cookie }))).status).toBe(200);
    expect((await p.fetch(chat(key))).status).toBe(401);
  });
  it("limits active keys per user", async () => {
    const p = make({ maxActiveKeys: 2 });
    const cookie = await login(p);
    await newKey(p, cookie, "a");
    await newKey(p, cookie, "b");
    const res = await p.fetch(req("/api/keys", { method: "POST", cookie, body: "{}" }));
    expect(res.status).toBe(400);
  });
  it("refuses a cross-origin state change", async () => {
    const p = make();
    const cookie = await login(p);
    const { id } = await newKey(p, cookie);
    const res = await p.fetch(req(`/api/keys/${id}`, { method: "DELETE", cookie, headers: { origin: "http://evil.example" } }));
    expect(res.status).toBe(403);
  });
  it("does not let one user revoke another user's key", async () => {
    const a = make();
    const cookieA = await login(a);
    const { id } = await newKey(a, cookieA);
    const b = make({ devLogin: async () => ({ id: 1, login: "mallory" }) });
    const cookieB = await login(b);
    expect((await b.fetch(req(`/api/keys/${id}`, { method: "DELETE", cookie: cookieB }))).status).toBe(404);
  });
});

describe("/v1 proxy", () => {
  it("needs a valid key", async () => {
    const p = make();
    expect((await p.fetch(req("/v1/models"))).status).toBe(401);
    expect((await p.fetch(chat("fi-nope"))).status).toBe(401);
  });
  it("forwards to the upstream and meters tokens per key", async () => {
    const p = make();
    const cookie = await login(p);
    const { key } = await newKey(p, cookie);
    await p.fetch(chat(key));
    await p.fetch(chat(key));
    expect(upstreamCalls[0].url).toBe("http://upstream.test/v1/chat/completions");
    const usage = (await (await p.fetch(req("/api/usage", { cookie }))).json()) as { totals: { requests: number; input: number; output: number } };
    expect(usage.totals).toEqual({ requests: 2, input: 20, output: 10 });
  });
  it("applies the model allowlist and rejects streaming", async () => {
    const p = make({ allowedModels: ["flisk-wolf"] });
    const { key } = await newKey(p, await login(p));
    expect((await p.fetch(chat(key, { model: "other" }))).status).toBe(400);
    expect((await p.fetch(chat(key, { model: "flisk-wolf", stream: true }))).status).toBe(400);
    expect((await p.fetch(chat(key, { model: "flisk-wolf" }))).status).toBe(200);
  });
  it("rate limits per key", async () => {
    const p = make({ ratePerMinute: 2 });
    const { key } = await newKey(p, await login(p));
    expect((await p.fetch(chat(key))).status).toBe(200);
    expect((await p.fetch(chat(key))).status).toBe(200);
    expect((await p.fetch(chat(key))).status).toBe(429);
  });
  it("refuses an oversized body", async () => {
    const p = make({ maxBody: 100 });
    const { key } = await newKey(p, await login(p));
    expect((await p.fetch(chat(key, { model: "m", pad: "x".repeat(500) }))).status).toBe(413);
  });
  it("does not meter a failed upstream call", async () => {
    const p = make({ fetchImpl: (async () => new Response('{"error":"down"}', { status: 502 })) as unknown as typeof fetch });
    const cookie = await login(p);
    const { key } = await newKey(p, cookie);
    expect((await p.fetch(chat(key))).status).toBe(502);
    const usage = (await (await p.fetch(req("/api/usage", { cookie }))).json()) as { totals: { requests: number } };
    expect(usage.totals.requests).toBe(0);
  });
});

describe("pages", () => {
  it("serves the console and /health", async () => {
    const p = make();
    expect((await p.fetch(req("/health"))).status).toBe(200);
    const home = await p.fetch(req("/"));
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("Sign in with GitHub");
  });
});
