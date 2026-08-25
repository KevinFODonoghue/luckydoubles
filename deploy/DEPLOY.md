# Deploying Lucky Doubles

The app stores everything in Postgres (`DATABASE_URL`), so it runs two ways:

- **Vercel (serverless)** — the primary path. `api/index.js` + `vercel.json`
  are already set up.
- **Any Node host** — `server.js` runs it as a normal long-lived server on a
  VPS, container, or Railway/Render-style host.

Environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Attaching Neon to a Vercel project injects it automatically. |
| `SESSION_SECRET` | no | Cookie signing key. If unset, a stable one is derived from `DATABASE_URL`. |
| `TZ` | no | League timezone; defaults to `America/New_York`. |
| `DATABASE_SSL` | no | Set to `no-verify` only if the DB host's TLS cert can't be verified. |

---

## Vercel + Neon (recommended)

1. **Import the repo** at vercel.com/new → `KevinFODonoghue/luckydoubles` →
   Deploy with all defaults (framework "Other", no build step). The very first
   deploy fails until the database exists — that's expected.
2. **Attach Neon:** project → **Storage** → **Create Database** → **Neon**
   (free plan) → connect it to the project. This injects `DATABASE_URL`.
3. **Create the schema** (one time) from any machine:
   ```bash
   npm install
   ```
   put the `DATABASE_URL` in `.env`, then:
   ```bash
   npm run schema
   ```
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the env.
5. Open the site, register (first account = league admin), share the link.

Notes:
- `vercel.json` includes a daily cron hitting `/healthz`, which pings the
  database — a nice uptime check on top of Neon waking automatically.
- Neon's free tier suspends compute when idle; the first request after a quiet
  spell takes an extra half-second while it wakes. Harmless.
- Pushing to `main` auto-deploys.

---

## Any Node host (VPS / droplet / container)

Same app, long-running:

```bash
git clone https://github.com/KevinFODonoghue/luckydoubles.git /opt/luckydoubles
cd /opt/luckydoubles && npm install --omit=dev
```

Set `DATABASE_URL` (and optionally the other env vars), run `npm run schema`
once, then use `deploy/luckydoubles.service` (systemd) and
`deploy/Caddyfile.snippet` (HTTPS reverse proxy) — both have inline
instructions. Health check: `GET /healthz`.

---

## Backups

The league lives in Postgres now. Neon keeps point-in-time restore history on
its own; for belt-and-suspenders, an occasional
`pg_dump "$DATABASE_URL" > league-backup.sql` from any machine does it.

## Wiping for a fresh season

`npm run reset` truncates everything (first registrant becomes admin again).
Against a remote database it requires `FORCE_SEED=1` on purpose.
