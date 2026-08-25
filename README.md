# 🎳 Lucky Doubles

A web app for running a weekly lucky-draw doubles bowling league: bowlers sign up
each Friday by 6:30 PM, the app pairs high averages with low averages at random,
everyone bowls three games, and team totals decide who won.

(Bowling calls this tournament format "blind doubles" — the app is branded
**Lucky Doubles** instead, since "blind" reads like blind dating to people
outside bowling.)

## How the league works in the app

| League rule | How the app handles it |
| --- | --- |
| Sign up by 6:30 PM Friday | Every upcoming Friday gets a week automatically, with a 6:30 PM signup deadline. A live countdown shows on the week page, and signups lock at the deadline (the admin can change the deadline per week). |
| Pair high average with low average, randomly | When the admin hits **Generate pairings**, bowlers are sorted by average and split into a high half and a low half. The high half is randomly matched against the low half — every team is one higher-average + one lower-average bowler, but who you draw is luck. |
| A place to enter averages | First-timers type their average right on the sign-up card (one tap: save + sign up). It's also editable any time on the Profile page, and the admin can set anyone's. You can't be in a draw without an average on file. |
| Total score decides who won | Each bowler enters their three games; the app totals both teammates' series and ranks the teams. Rank #1 wins. The admin finalizes the week to make results official. |
| Waitlist for odd numbers | If an odd number of bowlers are in when pairings are generated, the **last person to sign up** goes on the waitlist. The week page warns about this live while signups are open. |
| Admin tracks who paid | On the week page, the admin can tap the Paid/Unpaid badge next to each bowler. Bowlers see their own payment status. |
| Three games, ranked results | Score entry is per game (G1/G2/G3). Standings rank teams by total pins, with high game and high series callouts. A **Stats** page tracks season wins, average per game, high game, and high series per bowler across finalized weeks. |
| Own login, opt in/out weekly | Every bowler registers once with email + password, then just opts in or out each week. Opting in/out is one tap and allowed any time before the deadline. |

## Running it

Requires Node.js 22.13+ and a Postgres database (Neon, Supabase, or any other —
the league's data lives there).

```bash
npm install
```

Copy `.env.example` to `.env`, set `DATABASE_URL`, then:

```bash
npm start
```

and open http://localhost:3000. The schema is created automatically on first
boot (also available explicitly as `npm run schema`).

## Demo data

`npm run seed` fills the database with a demo league so you can click around:
a completed week with full results, and an open current week with 9 signups
(odd on purpose, so the waitlist warning is visible). Seeding **wipes all
league data first** — and refuses to touch a non-local database unless you run
it with `FORCE_SEED=1`.

Sign in with any of these — the password for all of them is `demo123`:

- `admin@league.test` — League Admin (admin access)
- `alice@league.test`, `marcus@league.test`, `priya@league.test`, `dave@league.test`,
  `jen@league.test`, `tom@league.test`, `rosa@league.test`, `chris@league.test`,
  `nina@league.test` — regular bowlers

Rebuild the demo any time with `npm run seed`.

## Going live for the real league

1. If any demo or test data exists, wipe it from inside the app: **Admin →
   Danger zone → Wipe all league data** (or `FORCE_SEED=1 npm run reset` from a
   machine with `DATABASE_URL`).
2. Open the site and register yourself. **The first account to register becomes
   the league admin**, so do this before sharing the link.
3. Share the URL with the league. Everyone registers once, sets their average,
   and opts in each week.

### The admin's Friday routine

The week page walks you through it — a progress strip shows the night's stage
(Sign-up → Teams drawn → Final), and when there's an obvious next step (deadline
passed, or all scores in) a callout with the right button appears at the top.

1. During the week, bowlers opt themselves in (you can add/remove people too).
2. Tap the Paid badge as people pay at the desk (a chip shows how many have paid).
3. At 6:30 (or whenever everyone's there), hit **Generate pairings**. If someone
   walks in late, add them and hit **Regenerate pairings**.
4. Bowlers enter their own games from their phones (or you enter any score as admin).
5. Hit **Finalize week** — winners are official and the week is locked into History.

Other admin tools (Admin page): create weeks on special dates, set anyone's
average, reset a forgotten password (shows a temporary one), promote a second
admin, track who's played.

## Deploying on the internet

Built for **Vercel + Neon Postgres** (free tiers): the repo ships a serverless
entry (`api/index.js` + `vercel.json`), and the only required env var —
`DATABASE_URL` — is injected automatically when you attach a Neon database to
the Vercel project. It also still runs as a plain long-lived Node server on any
VPS or container host pointed at the same `DATABASE_URL`.

See **[deploy/DEPLOY.md](deploy/DEPLOY.md)** for both walkthroughs, env vars,
the health check, and backups.

## Tech notes

- Node.js + Express 5, server-rendered EJS, no build step.
- Postgres via `pg` (schema in `scripts/schema.sql`); works locally as a normal
  server (`server.js`) and on Vercel as a serverless function (`api/index.js`).
- League timezone is pinned to `America/New_York` (override with `TZ`), so
  deadlines behave even on UTC hosts.
- Passwords hashed with bcrypt; signed session cookies (secure-only in
  production); forms are same-site protected; login attempts are throttled.
- `npm run dev` restarts the server on file changes.

## Design decisions worth knowing

- **Pairing:** "randomly pair highest with lowest" is implemented as
  high-half vs low-half random matching. If you'd rather have strict seeding
  (best avg ↔ worst avg, 2nd best ↔ 2nd worst…), that's a one-line change in
  `src/pairing.js`.
- **Scoring is scratch** (no handicap) — totals are raw pins, since pairing
  already balances the teams.
- **Averages are snapshotted at pairing time**, so someone editing their average
  mid-night doesn't change the record of how teams were built.
- **Re-pairing keeps entered game scores** (they belong to the bowler), and
  reopening signups clears teams but keeps the roster.
