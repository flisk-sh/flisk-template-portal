// The portal: GitHub sign-in, API keys, and a metered proxy to an upstream HTTP API. No dependencies.
// createPortal() returns a fetch handler over standard Request/Response, so tests drive it without a socket.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GithubUser { id: number | string; login: string; name?: string | null; avatar_url?: string }
export interface PortalOptions {
  name?: string;                      // product name shown in the console
  publicUrl: string;                  // the address people use, no trailing slash
  upstreamUrl: string;                // what /v1/* is forwarded to
  dataDir: string;                    // users, hashed keys, usage, cookie secret
  allowedModels?: string[];           // empty or missing: any model
  github?: { clientId: string; clientSecret: string };
  devLogin?: () => Promise<GithubUser>; // local sign-in as the machine's gh user; never set in production
  publicDir: string;                  // folder holding index.html
  maxBody?: number;                   // bytes
  ratePerMinute?: number;             // per API key
  maxActiveKeys?: number;             // per user
  bootstrapKey?: string;              // a fixed API key accepted from the start, for a preview that has no sign-in
  fetchImpl?: typeof fetch;           // for tests
}
interface User { id: string; login: string; name: string; avatar: string; created: string }
interface Key { id: string; userId: string; name: string; hash: string; prefix: string; last4: string; created: string; lastUsed: string | null; requests: number; input: number; output: number; revoked: boolean }
interface Db { users: Record<string, User>; keys: Key[] }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SESSION_DAYS = 7;

export function createPortal(opts: PortalOptions) {
  const maxBody = opts.maxBody ?? 64 * 1024;
  const ratePerMinute = opts.ratePerMinute ?? 30;
  const maxActiveKeys = opts.maxActiveKeys ?? 10;
  const doFetch = opts.fetchImpl ?? fetch;
  const secure = opts.publicUrl.startsWith("https");

  mkdirSync(opts.dataDir, { recursive: true });
  const dbFile = join(opts.dataDir, "db.json");
  const secretFile = join(opts.dataDir, "secret");
  if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const secret = readFileSync(secretFile, "utf-8").trim();
  const db: Db = existsSync(dbFile) ? JSON.parse(readFileSync(dbFile, "utf-8")) : { users: {}, keys: [] };
  const save = () => { writeFileSync(`${dbFile}.tmp`, JSON.stringify(db, null, 2)); renameSync(`${dbFile}.tmp`, dbFile); };
  const sign = (p: string) => createHmac("sha256", secret).update(p).digest("base64url");

  // A preview run (a CI runner with a public link) has no sign-in: one key comes from a secret instead. Only its hash is stored.
  if (opts.bootstrapKey) {
    const hash = sha(opts.bootstrapKey);
    if (!db.keys.some((k) => k.hash === hash)) {
      db.users.bootstrap ??= { id: "bootstrap", login: "preview", name: "Preview key", avatar: "", created: new Date().toISOString() };
      db.keys.push({ id: randomBytes(6).toString("hex"), userId: "bootstrap", name: "preview", hash, prefix: opts.bootstrapKey.slice(0, 5), last4: opts.bootstrapKey.slice(-4), created: new Date().toISOString(), lastUsed: null, requests: 0, input: 0, output: 0, revoked: false });
      save();
    }
  }

  const states = new Map<string, number>(); // OAuth state -> expiry
  const rate = new Map<string, number[]>();

  const json = (code: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
  const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });
  const sessionCookie = (uid: string) => {
    const p = b64({ uid, exp: Date.now() + SESSION_DAYS * 864e5 });
    return `fi_session=${p}.${sign(p)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
  };
  function sessionUser(req: Request): User | null {
    const m = /(?:^|;\s*)fi_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
    if (!m) return null;
    const [p, sig] = m[1].split(".");
    if (!p || !sig) return null;
    const want = Buffer.from(sign(p)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const s = JSON.parse(Buffer.from(p, "base64url").toString()) as { uid: string; exp: number };
      return s.exp > Date.now() ? (db.users[s.uid] ?? null) : null;
    } catch { return null; }
  }
  function upsertUser(gh: GithubUser): string {
    const id = String(gh.id);
    db.users[id] = { id, login: gh.login, name: gh.name ?? gh.login, avatar: gh.avatar_url ?? "", created: db.users[id]?.created ?? new Date().toISOString() };
    save();
    return id;
  }
  async function readJson(req: Request): Promise<Record<string, unknown>> {
    const text = await req.text();
    if (text.length > maxBody) throw Object.assign(new Error("body too large"), { status: 413 });
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  // A cross-site page cannot set a same-origin Origin header; SameSite=Lax cookies cover the rest.
  const sameOrigin = (req: Request) => !req.headers.get("origin") || req.headers.get("origin") === opts.publicUrl;

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") return json(200, { status: "ok" });
    if (req.method === "GET" && (path === "/" || path === "/index.html"))
      return new Response(readFileSync(join(opts.publicDir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/api/config") return json(200, { name: opts.name ?? "Portal", oauth: Boolean(opts.github), dev: Boolean(opts.devLogin), base: opts.publicUrl, models: opts.allowedModels ?? [] });

    // ---- sign-in
    if (path === "/auth/github") {
      if (!opts.github) return json(501, { error: "GitHub OAuth is not configured (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)" });
      const state = randomBytes(16).toString("hex");
      states.set(state, Date.now() + 600_000);
      const q = new URLSearchParams({ client_id: opts.github.clientId, redirect_uri: `${opts.publicUrl}/auth/callback`, state });
      return redirect(`https://github.com/login/oauth/authorize?${q}`);
    }
    if (path === "/auth/callback") {
      const state = url.searchParams.get("state"), code = url.searchParams.get("code");
      const expiry = state ? states.get(state) : undefined;
      if (!opts.github || !state || !code || !expiry || expiry < Date.now()) return json(400, { error: "bad state or code" });
      states.delete(state);
      const tok = (await (await doFetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: opts.github.clientId, client_secret: opts.github.clientSecret, code }) })).json()) as { access_token?: string };
      if (!tok.access_token) return json(400, { error: "GitHub did not return a token" });
      const gh = (await (await doFetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "flisk-portal" } })).json()) as GithubUser;
      if (!gh.id || !gh.login) return json(400, { error: "could not read the GitHub profile" });
      return redirect("/?section=keys", { "set-cookie": sessionCookie(upsertUser(gh)) });
    }
    if (path === "/auth/dev") {
      if (!opts.devLogin) return json(403, { error: "dev login is off" });
      return redirect("/?section=keys", { "set-cookie": sessionCookie(upsertUser(await opts.devLogin())) });
    }
    if (path === "/auth/logout") return redirect("/", { "set-cookie": "fi_session=; Max-Age=0; Path=/" });

    // ---- console API (session cookie)
    if (path.startsWith("/api/")) {
      const user = sessionUser(req);
      if (!user) return json(401, { error: "not signed in" });
      if (req.method !== "GET" && !sameOrigin(req)) return json(403, { error: "cross-origin request refused" });
      const mine = db.keys.filter((k) => k.userId === user.id);
      if (path === "/api/me") return json(200, user);
      if (path === "/api/keys" && req.method === "GET")
        return json(200, mine.filter((k) => !k.revoked).map(({ id, name, prefix, last4, created, lastUsed }) => ({ id, name, prefix, last4, created, lastUsed })));
      if (path === "/api/keys" && req.method === "POST") {
        const body = await readJson(req);
        if (mine.filter((k) => !k.revoked).length >= maxActiveKeys) return json(400, { error: `limit of ${maxActiveKeys} active keys` });
        const key = `fi-${randomBytes(24).toString("base64url")}`;
        const rec: Key = { id: randomBytes(6).toString("hex"), userId: user.id, name: String(body.name || "default").slice(0, 40), hash: sha(key), prefix: key.slice(0, 5), last4: key.slice(-4), created: new Date().toISOString(), lastUsed: null, requests: 0, input: 0, output: 0, revoked: false };
        db.keys.push(rec);
        save();
        return json(201, { id: rec.id, name: rec.name, key }); // the only time the full key is returned
      }
      const del = /^\/api\/keys\/([0-9a-f]+)$/.exec(path);
      if (del && req.method === "DELETE") {
        const k = mine.find((x) => x.id === del[1]);
        if (!k) return json(404, { error: "no such key" });
        k.revoked = true;
        save();
        return json(200, { ok: true });
      }
      if (path === "/api/usage") {
        const keys = mine.map((k) => ({ name: k.name, revoked: k.revoked, requests: k.requests, input: k.input, output: k.output, lastUsed: k.lastUsed }));
        const sum = (f: "requests" | "input" | "output") => keys.reduce((n, k) => n + k[f], 0);
        return json(200, { totals: { requests: sum("requests"), input: sum("input"), output: sum("output") }, keys });
      }
      return json(404, { error: "not found" });
    }

    // ---- /v1/*: API-key auth, metered, forwarded to the upstream
    if (path.startsWith("/v1/")) {
      const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
      const key = m ? db.keys.find((k) => !k.revoked && k.hash === sha(m[1])) : undefined;
      if (!key) return json(401, { error: { message: "invalid or missing API key", type: "invalid_request_error" } });
      if (req.method !== "GET" && req.method !== "POST") return json(405, { error: { message: "method not allowed" } });
      const now = Date.now();
      const recent = (rate.get(key.id) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= ratePerMinute) return json(429, { error: { message: `rate limit: ${ratePerMinute} requests per minute` } });
      rate.set(key.id, [...recent, now]);

      let body: string | undefined;
      if (req.method === "POST") {
        const parsed = await readJson(req);
        if (parsed.stream) return json(400, { error: { message: "streaming is not supported" } });
        if (opts.allowedModels?.length && !opts.allowedModels.includes(String(parsed.model))) return json(400, { error: { message: `model must be one of: ${opts.allowedModels.join(", ")}` } });
        body = JSON.stringify(parsed);
      }
      const up = await doFetch(`${opts.upstreamUrl}${path}`, { method: req.method, headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(120_000) });
      const text = await up.text();
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      try { usage = (JSON.parse(text) as { usage?: typeof usage }).usage; } catch { /* not JSON: count the request only */ }
      if (up.ok) {
        key.requests++;
        key.input += usage?.prompt_tokens ?? 0;
        key.output += usage?.completion_tokens ?? 0;
        key.lastUsed = new Date().toISOString();
        save();
      }
      return new Response(text, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/json" } });
    }
    return json(404, { error: "not found" });
  }

  return {
    fetch: async (req: Request): Promise<Response> => {
      try { return await handle(req); }
      catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 413) return json(413, { error: "body too large" });
        if (e instanceof SyntaxError) return json(400, { error: "invalid JSON" });
        console.error(e);
        return json(500, { error: "server error" });
      }
    },
  };
}
