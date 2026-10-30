# Flisk portal template

A small API portal you can put in front of any OpenAI-style HTTP API: **sign in with GitHub, create API keys, see usage**, and a metered `/v1/*` proxy that checks the key. One Bun service, no database, no npm runtime dependencies. Built and run locally with [Flisk](https://github.com/flisk-sh/flisk).

It started as the console for a small hosted model, so the example upstream is a local Ollama server. Point `UPSTREAM_URL` at anything else.

## What is already done

| | Where |
| --- | --- |
| Sign in with GitHub (OAuth, single-use state), and a local sign-in as your own `gh` user for development | `src/portal.ts`, `src/index.ts` |
| Signed, `HttpOnly`, `SameSite=Lax` session cookie; cross-origin state changes refused | `src/portal.ts` |
| API keys: shown once, stored as SHA-256 hashes, revocable, 10 active per user | `/api/keys` |
| `/v1/*` proxy: key required, optional model allowlist, no streaming, 64 KB body cap, 30 requests a minute per key | `/v1/*` |
| Usage per key (requests, input and output tokens, when the upstream reports `usage`) | `/api/usage` |
| A console page: sign in, keys, usage, docs, in the Flisk roadmap look | `public/index.html` |
| 18 tests: sign-in, forged cookies, key lifecycle, ownership, metering, rate limit, allowlist, body cap | `tests/portal.test.ts` |
| CI (typecheck and tests), a production Dockerfile and a Render blueprint | `.github/workflows/ci.yml`, `Dockerfile`, `render.yaml` |

## Run it locally

```bash
bun install --cwd services/app/web
cd services/app/web
FLISK_DEV_LOGIN=1 UPSTREAM_URL=http://127.0.0.1:11434 ALLOWED_MODELS=your-model bun run dev
```

Open <http://localhost:4000>, choose **Sign in with local GitHub (gh)**. This signs you in as whoever `gh` is logged in as on this machine, and the service refuses to start with it when `NODE_ENV=production`. Or run the whole project with `flisk up app`.

## Real GitHub sign-in

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App** (or the same under your organization).
2. Homepage URL: your `PUBLIC_URL`. Authorization callback URL: `PUBLIC_URL/auth/callback`.
3. Generate a client secret, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as environment variables. Never commit them.

## Settings

| Variable | Meaning | Default |
| --- | --- | --- |
| `PUBLIC_URL` | The address people use. The OAuth callback and the cookie's `Secure` flag come from it. | `http://localhost:PORT` |
| `UPSTREAM_URL` | Where `/v1/*` is forwarded. | `http://127.0.0.1:11434` |
| `ALLOWED_MODELS` | Comma-separated model names a request may use. Empty means any. | any |
| `PORTAL_NAME` | Product name in the console. | `Portal` |
| `DATA_DIR` | Users, hashed keys, usage and the cookie secret. Keep it on a volume. | `services/app/web/data` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app. | off |
| `BOOTSTRAP_API_KEY` | One API key accepted from the start, with no sign-in. For a CI preview run; only its hash is stored. | off |
| `FLISK_DEV_LOGIN=1` | Local sign-in as your `gh` user. Refused in production. | off |

## What it is not

- **Not a billing system.** Usage is counted; nothing is charged. Add Stripe, or any payment provider, yourself.
- **Not highly available.** State is a JSON file written by one process. For more than one instance or real traffic, swap the store in `createPortal` for a database.
- **No streaming** through the proxy yet, and no teams: one user owns their keys.
- **Render's free plan has no persistent disk**, so users and keys reset on every deploy. `render.yaml` uses a paid plan with a disk for that reason.
- Rate limits are in memory and per key, so they reset when the process restarts.

## Make it yours

Click **Use this template** on GitHub, then rename the project in `.flisk/project.json`, set `PORTAL_NAME`, point `UPSTREAM_URL` at your API, and edit `public/index.html`.

[MIT](LICENSE)
