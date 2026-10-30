// Entry point. Everything is configured by environment variables; see the README.
import { join } from "node:path";
import { createPortal, type GithubUser } from "./portal";

const production = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 4000);
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const clientId = process.env.GITHUB_CLIENT_ID;
const clientSecret = process.env.GITHUB_CLIENT_SECRET;
const wantDev = process.env.FLISK_DEV_LOGIN === "1";

// Dev login signs you in as whoever `gh` is logged in as on this machine. It is for local runs only.
if (wantDev && production) {
  console.error("FLISK_DEV_LOGIN=1 is refused when NODE_ENV=production.");
  process.exit(1);
}
const devLogin = wantDev
  ? async (): Promise<GithubUser> => {
      const proc = Bun.spawn(["gh", "api", "user"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) throw new Error("gh is not logged in: run `gh auth login`");
      return JSON.parse(out) as GithubUser;
    }
  : undefined;

const portal = createPortal({
  name: process.env.PORTAL_NAME ?? "Portal",
  publicUrl,
  upstreamUrl: (process.env.UPSTREAM_URL ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
  dataDir: process.env.DATA_DIR ?? join(import.meta.dir, "..", "data"),
  publicDir: join(import.meta.dir, "..", "public"),
  allowedModels: (process.env.ALLOWED_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  github: clientId && clientSecret ? { clientId, clientSecret } : undefined,
  devLogin,
  bootstrapKey: process.env.BOOTSTRAP_API_KEY || undefined,
});

Bun.serve({ port, hostname: process.env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"), fetch: portal.fetch });
console.log(`Portal on ${publicUrl} (github oauth: ${Boolean(clientId && clientSecret)}, dev login: ${wantDev})`);
