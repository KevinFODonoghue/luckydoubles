# Deploying Blind Doubles

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
| `LEAGUE_TZ` | no | League timezone — decides when signups close. Defaults to `America/New_York`, and is applied explicitly, so a host running in UTC (Vercel does) still closes signups at 6:40 PM at the lanes. |
| `DATABASE_SSL` | no | Set to `no-verify` only if the DB host's TLS cert can't be verified. |

---

## Vercel + Neon (recommended)

1. **Import the repo** at vercel.com/new → `KevinFODonoghue/luckydoubles` →
   Deploy with all defaults (framework "Other", no build step).
2. **Attach Neon:** project → **Storage** → **Create Database** → **Neon**
   (free plan) → connect it to the project. This injects `DATABASE_URL`.
3. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the env —
   or just push any commit. The app creates its own schema on first boot.
4. Open the site, register (first account = league admin), share the link.

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

Use **Admin → Danger zone → Wipe all league data** in the app itself (type
RESET to confirm) — no database access needed; the first registrant afterwards
becomes admin again. From a machine with `DATABASE_URL`, `npm run reset` does
the same (requires `FORCE_SEED=1` against a remote database, on purpose).
