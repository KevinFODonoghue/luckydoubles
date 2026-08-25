# Deploying Lucky Doubles

The app is a plain long-running Node process with its database in a SQLite file
(`data/league.db`). That means it needs a host with a **persistent disk** —
a VPS/droplet, or a managed host with a volume (Railway, Render, Fly.io).

> **Vercel / Netlify / other serverless platforms do not work.** Their
> filesystem is read-only and nothing written to disk survives between
> requests, so the app crashes on boot (`FUNCTION_INVOCATION_FAILED`) and even
> a patched version would lose all league data. Don't fight it — use a host
> with a disk.

Environment variables (all optional):

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Port the app listens on. |
| `DATA_DIR` | `./data` | Where the SQLite database lives. Point at the persistent disk. |
| `SESSION_SECRET` | auto-generated into `DATA_DIR` | Set explicitly in production so sign-ins survive rebuilds. |
| `NODE_ENV` | – | Set to `production` behind an HTTPS proxy. This flips session cookies to secure-only — if you test over plain `http://`, leave it unset or sign-in won't stick. |

---

## Option A — your own server (DigitalOcean droplet + Caddy)

Same playbook as any small Node app. On the server:

```bash
sudo mkdir -p /opt/luckydoubles && sudo chown $USER /opt/luckydoubles
git clone https://github.com/KevinFODonoghue/luckydoubles.git /opt/luckydoubles
cd /opt/luckydoubles && npm install --omit=dev
```

Install the service (edit `User=`, `PORT`, and the `SESSION_SECRET` line first):

```bash
sudo cp deploy/luckydoubles.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now luckydoubles
curl -s localhost:3100/healthz   # -> ok
```

Point a domain at the server, add the block from `deploy/Caddyfile.snippet` to
your Caddyfile with the real domain, then `sudo systemctl reload caddy`.
Caddy handles HTTPS automatically.

**Updating** after pushing changes to GitHub:

```bash
cd /opt/luckydoubles && git pull && npm install --omit=dev
sudo systemctl restart luckydoubles
```

**Backups:** the whole league is one file. A nightly cron line is plenty:

```bash
0 4 * * * cp /opt/luckydoubles/data/league.db /opt/luckydoubles/data/league.backup.db
```

---

## Option B — Railway / Render / Fly.io (managed, ~$5–7/mo)

The shape is the same everywhere: connect the GitHub repo, attach a small
persistent volume, point `DATA_DIR` at it.

**Railway:** New project → Deploy from GitHub repo. Add a **Volume** mounted at
`/data`. Set env vars `DATA_DIR=/data`, `NODE_ENV=production`, and a
`SESSION_SECRET`. Start command `npm start`. Generate a domain under Settings →
Networking.

**Render:** New → Web Service from the repo. Instance type Starter. Add a
**Disk** (1 GB) mounted at `/var/data`. Env vars `DATA_DIR=/var/data`,
`NODE_ENV=production`, `SESSION_SECRET`. Health check path `/healthz`.

**Fly.io:** `fly launch` (Node autodetected), `fly volumes create data --size 1`,
mount it at `/data` in `fly.toml`, set `DATA_DIR=/data` and the other env vars
with `fly secrets set`.

---

## First run in production

The database starts empty. Open the site, register yourself first — **the
first account becomes the league admin** — then share the link with the league.
(If you seeded demo data locally, it never leaves your machine; `data/` is
gitignored.)
