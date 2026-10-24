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

## Stage 1 — done (accounts data model, dormant; applied to the real database 2026-10-23)

- **Migrations** (`server/src/db/migrations.js`), additive only, no assumption about existing columns, each safe to run twice:
  `2026-10-23-accounts-tables` = `users` (id, email unique lower-cased, password_hash nullable, role `user` | `owner`,
  email_verified_at, timestamps), `sessions` (id, user_id → users, **token_hash** unique — the token itself is never stored —,
  created / expires / last_seen, user_agent), `email_codes` (id, user_id, email, purpose, code_hash, attempts, created / expires /
  used), `projects.owner_id TEXT REFERENCES users(id)` nullable with **no ON DELETE action** (deleting a user who owns projects
  fails; deleting a project works as before; a project created the old way still inserts with no owner) + index.
  `2026-10-23-accounts-owner` = the owner account from `SAS_OWNER_EMAIL` (role `owner`, no password yet) and every project
  with no owner given to it; without a valid address it fails.
- **One transaction** (`db/apply.js applyMigrations`): every pending migration + its row in `schema_migrations` in one
  `BEGIN IMMEDIATE`; a failure anywhere rolls all of it back (tested: the database's schema and counts identical afterwards).
  The rehearsal (`db/rehearse.js`) now uses the same function on its copy and also checks ownership (`ownershipProblems`: no
  unowned project, no dangling owner, an owner exists).
- **`npm run db:migrate -w server [-- --owner <email>]`** (`db/migrate.js migrateDatabase`): refuses while something listens on
  the API port; checked backup → rehearsal on a scratch copy (must pass) → apply in one transaction → row counts before / after,
  integrity, foreign keys, ownership. The server never migrates by itself at startup: with `SAS_ACCOUNTS` off nothing reads the
  new tables, and `toProject` leaves `owner_id` out of the API, so the app gets exactly what it got before.
- **Real database** (`Site-Audit-Studio-maindataapp.db`): backup `dataackupsapp-2026-10-23T06-08-26.db` (17.5 MB), rehearsal
  passed, then `db:migrate` (its own backup `app-2026-10-23T06-08-39.db`) applied both migrations. Counts before = after:
  projects 10, analyses 53, recreates 79, reaudits 65; new: users 1 (owner chadinesh228@gmail.com), sessions 0, email_codes 0,
  schema_migrations 2; 0 projects without owner; `mirror_mode` kept; integrity ok.
- Tests: `stage1.test.js` (5), `stage0.test.js` (8, rehearsal now given an owner), `single-page.test.js` (5).

## Stage 2 — done (sign-up, sessions, the gate; email verification built, not required)

- **`/api/auth`** (`server/src/accounts/routes.js`), mounted only while `SAS_ACCOUNTS=1`: `POST /signup`, `POST /login`, `POST /logout`,
  `GET /me`, `POST /verify/send`, `POST /verify { code }`. Errors are `{ error: <sentence>, field? }` for the form.
  - Passwords: Node's scrypt (`accounts/passwords.js`, N 2^15, r 8, p 1, 16-byte salt, parameters stored in the hash), 8–200 chars;
    an unknown address does the same scrypt work and gets the same "Wrong email or password."
  - Sessions (`accounts/store.js`): 32 random bytes (base64url) in the cookie, only its SHA-256 in `sessions`; 30 days; a sign-in
    replaces the session it came with. Cookie `sas_session` (`__Host-sas_session` when Secure): HttpOnly, SameSite=Lax, Path=/,
    Secure from `SAS_COOKIE_SECURE` (default on when `SAS_PUBLIC_ORIGIN` is https).
  - Email codes: six digits (`randomInt`), only `sha256(id:code)` stored, 15 min, 5 tries, one new code per minute; sent on
    sign-up when not verified. **No mail module yet: the code is written to the server log** (never in production, never in a
    response).
  - An **unverified** account is a claim, not an ownership: signing up again with its address sets a new password and ends its
    sessions (whoever verifies the address keeps it). That is how the owner account from db:migrate (no password) is taken. A
    verified address → 409 "…Sign in instead."
  - Limits in memory: 10 failed sign-ins per address + IP per 15 min, 20 sign-ups per IP per hour (429 + Retry-After).
- **The gate** (`accounts/gate.js apiGate`): every `/api` route but `/api/auth` and `/api/health` — SSE, screenshots, captures,
  downloads, reports included — needs a session (401 `auth: 'signin'`) of a verified account (403 `auth: 'verify'`); `req.user`.
  **Origin check** (`accounts/http.js originCheck`) on every state-changing `/api` request: Origin must be `SAS_PUBLIC_ORIGIN`, its
  localhost / 127.0.0.1 twin, or the address the request was sent to (403 otherwise).
- **`SAS_DEV_NO_VERIFY=1`**: a new account is verified on sign-up. Default off; in effect only with NODE_ENV ≠ production **and** a
  loopback bind; set in any other situation the server **refuses to start** (`config/index.js startupProblems`, the
  SAS_ALLOW_LOCALHOST pattern, before the database is opened); while on, `!!! SAS_DEV_NO_VERIFY is ON … !!!` at every start.
- `SAS_ACCOUNTS=1` now starts — unless the database has pending migrations (refused, "run npm run db:migrate"). The accounts modules
  are loaded only when on, so off is exactly the old server (no auth routes, no gate, no queries on the new tables).
- **Test accounts** (`npm run accounts -w server [-- list | delete <email> … [--yes]]`, `scripts/accounts.mjs`): deletes named
  accounts with their sessions and email codes only (codes reference the user, so they must go too); refuses the owner account, an
  account that owns a project, and an unknown address — one refusal and nothing is deleted; without `--yes` it only shows; in one
  transaction that also checks projects / analyses / recreates / reaudits did not change.
- **Not done yet**: projects are not filtered by owner (a signed-in user sees every project) and a new project gets no owner_id;
  the app (client) knows nothing of sign-in (with accounts on it gets 401s) — step 3.
- Tests: `stage2.test.js` (9, real server processes over HTTP), `stage0` (8, updated: accounts on no longer refused; the refusal
  loop now covers SAS_DEV_NO_VERIFY with a network bind), `stage1` (5), `single-page` (5), `screens` (3).

## Stage 3 — done (ownership, one local address, the marketing form, change password)

- **Ownership** (`server/src/accounts/ownership.js projectGate`, mounted on `/api/projects/:id` after the gate): every route of a
  project — itself, PATCH (name or url), DELETE, pages, audit, report (html / json / pdf), favicon, analyze + current + SSE,
  screenshots, recreate (start / resume / stop / current / list), its SSE, captures, fidelity and exact images, download (GET and
  HEAD), export, as-is preview, preview (GET / POST / DELETE), re-audit + current + SSE — needs the signed-in account to own it.
  Someone else's project answers exactly like one that does not exist: **404 "Project not found."**, never 403. Sub-ids (analysis,
  copy, re-audit) were already tied to the project in the path by every route, so owning the project is owning what is under it.
  `GET /api/projects` lists the account's own projects; `POST` sets `owner_id` to it (in one transaction with the insert). A
  project with no owner (made with accounts off, or by a script) is nobody's and is counted in a warning at start.
  **Found and fixed on the way**: the SSE stream of a *live* job (`jobs/sse.js streamJob`) did not check the job's project, so any
  project's path could follow another project's running job by its id (with accounts off too).
- **Jobs and owners**: a job records `ownerId` from the project row (`jobs/manager.js`, `ownerOf(id)`), never from a session —
  an auto-resume after a restart, a queued export or re-audit has no signed-in user. Not sent to the app.
- **Change password**: `POST /api/auth/password { currentPassword, newPassword }` (current one required, 10 wrong tries / 15 min,
  must differ), every other session of the account ends, this one stays. App: **account line at the foot of the sidebar**
  (`client/src/components/account/AccountMenu.jsx`: email, Change password dialog, Sign out; a sign-out icon in the rail); hidden
  when the API has no accounts (`/api/auth/me` 404).
- **One local address** (`npm run local` → `scripts/local.mjs` + `scripts/local-proxy.mjs`), http://localhost:8080:
  `/` → the marketing site's `next dev` (:3000, `../remastly-website`, `SAS_MARKETING_DIR`), `/app/` → the tool's Vite (:5173),
  `/api/` → the API (:4000, started with `SAS_ACCOUNTS=1`, `SAS_PUBLIC_ORIGIN` = `APP_ORIGIN` = the proxy's address, and
  `SAS_DEV_NO_VERIFY=1` — the API prints its warning line; `npm run local -- --verify` for the real behaviour). Host is passed
  through, so the API's Origin check and the dev servers see one origin; WebSocket upgrades (hot reload) are proxied.
  **The gate on /app/**: the proxy asks the API (`GET /api/auth/me` with the visitor's cookie; a verified answer is kept 3 s per
  cookie): not signed in → a page request is redirected to `/auth?mode=signin&next=<path>` (`&verify=1` when unverified), any other
  request (script, style, socket) → 401. Everything under `/api` — SSE, screenshots, captures, downloads, reports — is gated by the
  API itself (cookie Path=/ reaches it). The launcher refuses to start when 4000 / 5173 / 3000 / 8080 are taken.
- **Client**: `base: '/app/'` (Vite; `/` and `/app` redirect to `/app/` when Vite is opened directly). The API stays at `/api`
  (not `/app/api`): the same path the marketing form posts to, so the Vite proxy key stays `/api`. Every API URL goes through
  `client/src/api/base.js` (`API_BASE` = `VITE_API_BASE` or `/api`, `apiUrl`, `fromServerUrl` for the server-built screenshot
  URLs `normalizeAudit` rewrites): `api/client.js` (fetch, SSE, downloadUrl, PDF), `siteData.js`, `Site.jsx`, `CompareStep.jsx`,
  `RecreateReport.jsx`. A 401 / 403 carrying `auth` sends the visitor to the sign-in page and back (`goToSignIn`). Port 8080 counts
  as the app's own address for live previews (`CompareStep` LIVE_PORTS, `SitePreview` APP_PORTS).
- **Marketing site** (`remastly-website/components/auth/AuthForm.tsx`, the only file changed there; **not committed**: that repo
  has other uncommitted work of the user's): `fetch` to `NEXT_PUBLIC_API_BASE` (default `/api`) `/auth/login` | `/auth/signup`
  instead of a native POST; a server error goes under its field when it names one, else into the notice (`role=alert`); signed in →
  `?next=` (only `/app…`) or `NEXT_PUBLIC_APP_URL`; an unverified account is told it waits for email confirmation (room for the code
  step); "Forgot password?" says reset is not open (the old link pointed at a page that does not exist). The name and the optional
  website field are not sent (the API has no place for them yet).
- Tests: `stage3.test.js` (4: two accounts against 35 routes of each other's project incl. files / SSE / downloads / reports, mixed
  ids, an unowned project, create sets the owner; change password; job owner from the row; SSE of another project's live job),
  `stage3-proxy.test.js` (2: routing, the gate for pages / assets / sockets, sign-up through the proxy, sign-out closes /app/,
  unverified → verify=1), and stage0–2, single-page, screens, recreate-jobs, report: 61 / 61. A scratch browser run (real API, real
  Vite on 5174, the proxy, Chromium, a stand-in marketing page) passed all 12 checks. Client `npm run build` and the marketing site's
  `tsc --noEmit` pass. Not run: `npm run local` with the real `next dev` (the user's own servers held 4000 / 5173 / 3000).
- **Noticed, not changed**: `routes/recreate.js EXACT_FILE` has lost its backslashes (`d{3,4}` instead of `d{3,4}`), so the exact
  comparison's pictures always 404 — the known regex trap, on the exact-mode branch's code.

## Stage 4 — done (the app looks like the marketing site; the sign-up name and website are used)

- **Name**: migration `2026-10-23-users-name` (nullable `users.name`), sign-up stores the form's "Your name" (trimmed, ≤ 80, no
  control characters or angle brackets, else 400 `field: 'name'`), `publicUser.name`; the sidebar shows it (the email when an
  account has none, the email on hover). **Website to rebuild**: the form sends the visitor to `/app/?site=<address>`, which opens
  Add a website with the address filled in (the authorization box still to be ticked) and takes it out of the URL.
- **Look** (client only, no layout change): `styles/tokens.css` takes the marketing site's values under the existing names —
  warm neutrals (#FAFAF7 ground, #111 ink, #3d3c38 / #6b6a65 / #9a978f text, #e8e6e0 borders), `--ink` / `--band-dark` (#111) and
  on-dark colours, accent tints derived from #C2410C, warm shadows, radii 8 / 12 / 18 / 24 + pill, focus ring 4 px; fonts
  **Hanken Grotesk** (text, 15 px base) and **Newsreader** 500 (headlines: home title, section titles, the site's name, step
  titles, dialog titles; `.display` utility) via `@fontsource-variable/*` (Inter dropped from the entry). Buttons are pills,
  the primary with the accent's soft shadow; inputs 42 px, 12 px corners, ink border on focus; labels are the marketing site's
  small caps, and a section's first line is `// Overview` (`.eyebrow.intro`). The home welcome band is a near-black band (white
  serif headline, lining figures, the accent lightened for it); the logo mark sits on an ink tile.
- Screenshots at 1440 next to the marketing site: scratchpad `compare/*.jpg` of the 2026-10-23 session (data: a read-only copy).
- Tests: stage1, stage2 (+name), stage3: 18 / 18; client build passes; the marketing site's `tsc --noEmit` passes.

- **Name and tab** (same step): the product reads "Remastly" wherever a user sees it (sidebar, home footer, README headline, the
  bot-protection and canvas messages, the generated stylesheet header and the downloads' READMEs); SAS_* names, package / folder /
  database / module names and the crawler user agents are unchanged. The tool's tab icon is the marketing site's own `/icon`
  (`remastly-website/app/icon.tsx`) on the same origin — `vite-ignore` keeps Vite from moving it under `/app/` — so the two cannot
  drift; theme colour #FAFAF7; tab title "<site> · Remastly" / "Your websites · Remastly". Checked in a headed Chromium: both tabs
  load byte-identical icons.

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
- **Done (2026-10-24): previews are paths of the app's own address, every document sandboxed by header.** The API serves
  `/preview/<token>/…` (`recreate/previewRoute.js`; `recreate/previewTokens.js` issues a 24-character token when a preview
  starts — `startPreview`, `startAsIsPreview` — and drops it when it stops). The token is the only permission (the frame has
  no session: it is an opaque origin, so the browser sends it no cookie). Every HTML / SVG answer carries
  `Content-Security-Policy: sandbox allow-scripts; frame-ancestors <app>` (a build of ours also the strict policy, written with
  the visitor's origin instead of `'self'`), `Access-Control-Allow-Origin: *` (a sandboxed document fetches its own files
  cross-origin), no-store, no-referrer. Root-relative addresses in pages and stylesheets are moved under the preview's path on
  the way out; addresses a copy's own script builds at run time are not (they ask the app's root and get 404 — nothing of the
  app). The app frames every copy with `sandbox="allow-scripts"` (plain copies `sandbox=""`), never `allow-same-origin`
  (`CompareStep.jsx`). `/api` refuses `Origin: null` and `Sec-Fetch-Site: cross-site` for every method
  (`security/foreignOrigin.js`). Vite (`/preview` proxied) and `scripts/local-proxy.mjs` route the prefix to the API.
  Proof: `test/preview-sandbox.test.js` (the risk shown first, then the fix, in a browser against the real API),
  `test/preview-route.test.js`. The loopback servers remain for measurement only (the preview step, the re-audit).
- Before (kept for the record): an HTML copy was served by `recreate/preview.js` on `127.0.0.1`, a port of its own in **5100–5199**
  (`PREVIEW_PORTS`, host check `127.0.0.1:<port>` / `localhost:<port>`, `frame-ancestors` = `APP_ORIGIN` from `audit/frame.js`,
  default `http://localhost:5173`); an as-is copy by `behavior/preserve/asisPreview.js` (own port via `serve.js`); an app stack by
  `serveStack.js startStack` on **fixed** ports 4501 / 4502 / 4503 (`preserve/stage.js PORT`); throwaway servers on random ports
  (`verify/server.js`, `preserve/serve.js`, `render.js`, the re-audit, `security/egressProxy.js`). The client frames `preview.url`
  as given (`CompareStep.jsx`, `SitePreview.jsx`) and picks live vs picture by `window.location.port === '5173'`.
- The alternative not taken: **subdomains**
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
