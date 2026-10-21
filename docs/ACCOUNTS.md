# Accounts — plan and status

Branch `accounts` (from `copy-my-site`). Destination: a hosted product other people use — sign up → email OTP → own dashboard →
Free plan (one site) → upgrade — on the production architecture of `CLONER_SPEC.md` Phase 6 and `docs/fidelity-audit.md` Step 8
(API + worker, queue, Docker with the Playwright image, sandbox, object storage, previews by path or subdomain, persistent disk).
Accounts and that work are one destination. Stages are built and tested one at a time; nothing is a big-bang change.

Rules: never write the real data folder (`Site-Audit-Studio-main\data`, from `server/.env SAS_DATA_DIR`); read-only checks of it
are allowed. The user's dev server (4000 / 5173) runs from `Website-Audit-exact`: code work happens in its own worktree
(`../Website-Audit-accounts` for this branch). Run only the test files of what you touch.

## Stage 0 — done (safety net, no user-visible change)

- **The API listens on this computer only** (`server/src/index.js`, `config/index.js bindHost`): `127.0.0.1` by default,
  `SAS_BIND_HOST` for a hosted deployment. Before, `app.listen(PORT)` answered on every interface with no login. The Vite proxy
  targets `127.0.0.1:4000` (on this machine `localhost` resolves to `::1` first).
- **`SAS_ALLOW_LOCALHOST`**: off by default (unchanged), and now only in effect while the API is bound to a loopback address
  (`config/index.js allowLocalhost`, used by `security/netGuard.js userPolicy`). Set with a network bind, the server refuses to start.
- **`SAS_ACCOUNTS`**: default off = today's tool. Accounts are not built, so `1` refuses to start rather than run half of them.
- The refusals run in `config/startup.js`, imported first by `src/index.js`: modules evaluate in import order, so a refused start
  never opens the database (tested: no `app.db` is created).
- **Every path in one module** (`server/src/config/paths.js`): `DATA_DIR`, `DB_FILE`, `PROJECTS_DIR`, `projectDir`, `auditDir`,
  `recreateRoot`, `BACKUPS_DIR`, `LOGS_DIR`, `tempDir()`, `TOOLCHAINS_DIR` / `toolchainDir`. Nothing moved: every default resolves
  where it did (tested). There is no downloads folder: zips and PDFs are streamed from the copy's folder. `db/index.js` keeps
  exporting `DATA_DIR` / `projectDir`, so other branches' imports still work.
- **Database backup** (`server/src/db/backup.js`, `npm run db:backup -w server [-- --db <file> --dir <folder>]`): `VACUUM INTO` a
  dated file (`<data>/backups/app-<UTC time>.db`) over a read-only connection — WAL rows included, source never written — then
  checked (integrity_check, same tables and row counts). Not run on the real database.
- **Migration rehearsal** (`server/src/db/rehearse.js`, `npm run db:rehearse -w server [-- --db <file> --keep --json]`): a backup copy
  in the temp folder; the server's own startup schema (`db/schema.js applySchema`, moved out of `db/index.js`, which still calls it)
  and every pending migration (`db/migrations.js`, empty in stage 0) applied to the copy; proof that no table, column, row or id was
  lost or changed, integrity and foreign keys checked; columns the source has that this code does not know are listed. Never
  imports `db/index.js`. **Run read-only against the real database on 2026-10-21: passed** (11 projects, 54 analyses, 84 copies,
  70 re-audits, nothing lost; `projects.mirror_mode` unknown to this code; the real file's time and size unchanged).
- Tests: `stage0.test.js` (8: bind default / override, the localhost rule, the switch, paths, backup with WAL rows, rehearsal incl.
  catching a dropped column / deleted rows / a failing migration, the real server listening on 127.0.0.1 and not on the LAN
  address, refusal without opening a database). Changed modules' tests: 63 / 63 (copy-served, interruptions, preserve-asis-offline,
  reaudit, recreate-export, recreate-jobs, report, screens, shared-cache, single-page). `netGuard.test.js`: its two known Windows
  failures (`*.localhost` DNS), nothing new.

## Findings recorded for later stages

### Schema drift across branches (item 6)
- `projects.mirror_mode INTEGER NOT NULL DEFAULT 0` was added by branch **`mirror-mode-wip`** (commit `09b03ab`, 2026-10-14,
  "WIP mirror mode (stopped by the user before it was finished)"): an exact copy that also keeps the site's own code, page by page
  where it runs offline (`recreate/mirror/`), off by default. That branch's server ran against the real database once, so the column
  is there; no other branch reads it.
- Every other branch (25, plus every worktree on disk, uncommitted files included): the same four tables and either the current
  column set or an older subset. No other branch adds a column or a table.
- Why it matters: one real database is migrated by whichever branch's server opens it. Additive, nullable migrations keep that safe
  (old code ignores new columns). Accounts migrations must stay additive, run through `db:rehearse` first, and be listed in
  `db/migrations.js` — never inline `ALTER`s scattered per branch.

### SQLite hosted, or Postgres?
- SQLite (`node:sqlite`, WAL) is fine for **one** API process on one machine with a persistent disk: it is what runs today, and the
  backup / rehearsal tools above work with it.
- It stops fitting when the Phase 6 split happens: an API **and** separate worker processes (possibly on other machines) writing job
  state, several API replicas, or a managed platform without a persistent local disk. A shared SQLite file over a network disk is
  not safe. That points to **Postgres** for hosted.
- To keep that move cheap: all SQL goes through `db/index.js` today (prepared statements, plain SQL, no SQLite-only features except
  `PRAGMA`s and `addColumn` via `PRAGMA table_info`). Keep new code to portable SQL, ids as TEXT UUIDs (already), timestamps as ISO
  text, and put new statements behind small functions so a later driver swap is one module. Decide before Stage 7.

### Previews when hosted
- Today: an HTML copy is served by `recreate/preview.js` on `127.0.0.1`, a port of its own in **5100–5199**
  (`PREVIEW_PORTS`, host check `127.0.0.1:<port>` / `localhost:<port>`, `frame-ancestors` = `APP_ORIGIN` from `audit/frame.js`,
  default `http://localhost:5173`); an as-is copy by `behavior/preserve/asisPreview.js` (own port via `serve.js`); an app stack by
  `serveStack.js startStack` on **fixed** ports 4501 / 4502 / 4503 (`preserve/stage.js PORT`); throwaway servers on random ports
  (`verify/server.js`, `preserve/serve.js`, `render.js`, the re-audit, `security/egressProxy.js`). The client frames `preview.url`
  as given (`CompareStep.jsx`, `SitePreview.jsx`) and picks live vs picture by `window.location.port === '5173'`.
- Hosted: a user's browser cannot reach `127.0.0.1:<port>` on the server. Previews become **subdomains**
  (`<recreateId>.preview.<domain>`, recommended: each copy gets its own origin, so a copy's own scripts can never touch the app's
  cookies) served by one preview service that maps host → copy folder, or **paths** (`/preview/<recreateId>/…`, simpler, but every
  copy shares one origin and needs a `<base>` / link rewriting, which an as-is copy's own scripts break). Either way:
  `frame-ancestors` from config (the app's real origin), the live/picture rule from config instead of the port, the fixed
  4501–4503 ports replaced by allocated ones, and the throwaway random-port servers stay internal to the worker (never exposed).

### The global job lock, and a per-user queue
- Today `jobs/manager.js exclusive()` runs **one job at a time across every kind and every project**, FIFO, and holds the
  keep-awake while anything waits; `lockBusy()` feeds `/api/health busy` (the dev runner waits on it). Each manager also allows one
  job per project. Also assuming one job at a time: the fixed stack ports 4501–4503 (two as-is copies of the same stack at once would
  collide); `audit/resources.js parallelism()` sizes browser contexts from the whole machine's free memory as if the job owned it;
  `SAS_MAX_PARALLEL` is global; the keep-awake (a desktop concern, off when hosted).
- A per-user queue needs: a job record with `owner_id` (and plan), a real queue (Phase 6: BullMQ + Redis, or a DB-backed queue)
  with N worker slots instead of one lock; a fairness rule (round-robin per user, per-plan concurrency, e.g. Free 1, paid 2); per-job
  memory budgets instead of whole-machine heuristics; ports allocated per job; the SSE progress contract kept (`JobManager`'s
  interface stays, its backend changes — as `fidelity-audit.md` Step 8 already decided).

### Session cookies
- Yes: an opaque random session id (≥ 32 bytes) in a cookie, stored hashed server-side with expiry; `HttpOnly` always;
  `SameSite=Lax` (the app's own pages; `Strict` would drop the session on links from email); `Secure` from config —
  `SAS_COOKIE_SECURE` defaulting to on whenever the app's public origin is `https:`, off for local `http://127.0.0.1` — so the
  same code runs locally over HTTP and hosted over HTTPS. Cookie name `__Host-…` when Secure (no Domain, Path `/`). A cookie,
  not a header token, because SSE (`EventSource`) and `<img src>` cannot send headers. CSRF: SameSite=Lax plus an Origin check on
  every state-changing request.

## Next (one stage at a time, each tested on its own)
1. Stage 1 — accounts data model, dormant: `users`, `sessions`, `email_codes`, nullable `projects.owner_id` (no cascade), an owner
   account from env with every existing project assigned to it in one transaction; rehearsed on a copy of the real DB first.
2. Stage 2 — mail module (`nodemailer` SMTP from env + a log transport for development).
3. Stage 3 — sign-up, OTP, sessions, every route filtered by owner (switch on, scratch data, two accounts).
4. Stage 4 — login screens in the client. 5. Plans and limits. 6. Upgrade / payments. 7. Hosting (Phase 6). 8. Remastly restyle.
Decisions needed before Stage 3: passwordless OTP vs password + OTP verification; email provider; what counts as "one site";
payments provider.
