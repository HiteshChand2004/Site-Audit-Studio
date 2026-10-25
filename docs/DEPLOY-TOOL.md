# Deploying Remastly (marketing site + tool) to one Linux server

Written 2026-10-25 for a plain **Ubuntu 24.04 LTS VPS**. Hosting is not decided yet. Nothing in this guide has been run on a real
server: every command comes from reading the code. Points I am not sure of are marked **Unsure**.

What runs, all on one machine, behind one domain (`example.com` below; use your own):

| Address | What answers | Process |
|---|---|---|
| `https://example.com/` (everything not listed below) | the marketing site (Next.js 16, `../remastly-website`) | `sas-site.service` on 127.0.0.1:3000 |
| `https://example.com/app/` | the tool's web app (React + Vite, built to static files in `client/dist`) | Caddy serves the files |
| `https://example.com/api/` | the API (Express 5, Node, SQLite) | `sas-api.service` on 127.0.0.1:4000 |
| `https://example.com/preview/<token>/` | previews of copies, sandboxed by header (`recreate/previewRoute.js`) | the same API process |

This is the same layout `npm run local` builds on a laptop (`scripts/local.mjs`, `scripts/local-proxy.mjs`). One address for
everything is required, not just convenient. The marketing site's sign-in form posts to `/api/auth/*`, and the session cookie
(`Path=/`, `__Host-sas_session` over HTTPS) has to reach the tool at `/app/` and the API at `/api/`.

## What changes on other hosts

- **Another VPS provider** (Hetzner, DigitalOcean, AWS Lightsail / EC2, Google Compute Engine, OVH…): the same steps apply. Two
  things differ. (1) The firewall may sit in the provider's panel as well as `ufw`. (2) **Several providers block outbound mail
  ports on new accounts** (25 always, often 465 and 587 too). Check this before you rely on SMTP (see step 11) and ask support to
  unblock 587 if needed.
- **Another Linux distribution**: `npx playwright install-deps` supports Debian and Ubuntu only. On anything else you must find
  Chromium's system libraries yourself.
- **ARM servers** (Ampere, Graviton): Playwright, sharp, esbuild and Next.js all ship Linux arm64 builds. **Unsure**: nothing
  here has ever run on arm64.
- **Containers / platforms** (Docker, Render, Railway, Fly.io, Cloud Run…). The repo has no Dockerfile, and these rules hold:
  - Exactly **one** API instance per data folder. A second one is refused by `<data>/server.lock` (`config/dataLock.js`).
  - The data folder must be a **persistent volume**. It holds the database and every copy.
  - Deploys must be **stop-then-start**, never rolling or zero-downtime. A lock from another host blocks the new instance for up
    to 120 s.
  - Do not use scale-to-zero or request-time CPU limits. Jobs run in memory for 20 minutes to several hours.
  - Give Chromium a big shared-memory area (`--shm-size=1g` or `--ipc=host`). Docker's default of 64 MB crashes it.
  - The memory gate reads `os.freemem()`. Inside a container that is the **host's** free memory, not the container's limit, so
    set `SAS_JOB_MIN_FREE_MB` and `SAS_MAX_PARALLEL` by hand.
- **A managed load balancer / TLS in place of Caddy**: it must pass `Host`, `X-Forwarded-Proto` and `X-Forwarded-Host` through.
  The preview builds its content policy from them (`requestOrigin`). It must also not buffer `text/event-stream` (job progress is
  Server-Sent Events, with a ping every 15 s), and it must allow long responses (zips are streamed).
- **The planned split** (API + separate workers + Postgres, `docs/ACCOUNTS.md` "SQLite hosted, or Postgres?") is a different
  deployment. This guide is the single-machine one that the code supports today.

---

## 1. Server size

Figures come from the measured runs in `docs/HANDOFF.md` ("For the hosting discussion").

**Memory for one job**: about **2.2 GB** used while it runs. The sankalpam as-is copy plus re-audit took free memory from 5065 MB
to 2845 MB. The server process peaked at 702 MB RSS; the rest was Chromium and Lighthouse's Chrome. The pipeline's own rules add
up to about 1.8 GB (`audit/resources.js`). A job does not start until `SAS_JOB_MIN_FREE_MB` (default 2048) is free. Two jobs at
once once crashed a 15 GB laptop, in a mode that was not recorded.

**A conversion build** (React + Vite or Next.js copy) is one extra Node process (`build/toolchain.js runToolchain`: `vite build`
+ prerender, or `next build` + an after-build step), with a 6-minute (Vite) / 8-minute (Next.js) limit. On the one-page nyaayai
runs it took under half a minute and free memory dipped by **about 0.3–0.4 GB** while it ran (sampled once every few seconds, so
the real peak may be higher). The job's lowest point stayed in its browser checks, so the 2.2 GB above still holds. **Unsure**:
not measured on a site with many pages; `next build` starts several workers on a machine with more CPUs.

**How long a job runs** (measured):

| Job | Typical | Worst |
|---|---|---|
| Analyze (1–25 pages) | 25–160 s | 305 s |
| As-is copy (the product), per page | 17–22 min for the first page (budget 20 min/page + 10 per stack) | 22 min |
| Clean copy, older mode (10–30 pages) | 23–30 min | 146 min |
| Re-audit | 145–300 s | 399 s |

**Disk**:

| Item | Size |
|---|---|
| Clean copy | 16–235 MB |
| As-is copy of one page | ~130 MB |
| + converted to React + Vite (kept with the copy) | + ~75 MB (the copy twice: `public/` and the built `dist/`) |
| + converted to Next.js (kept with the copy) | + ~75 MB (`public/` and the built `out/`; Next's `.next/` build folder, ~71 MB, is removed once the copy is checked) |
| + converted to MERN (kept with the copy) | + ~75 MB (the copy twice: `client/public/` and the built `client/dist/`) |
| Analysis | 1–3 MB |
| Dead workspace | 10–118 MB, removed by the cleanup |

With the default 30-day retention, 100 websites hold about 10–25 GB of older copies plus every site's newest copy (never removed
by age). The conversion figures are the nyaayai homepage runs of 2026-10-25 (one page, an 85 MB as-is copy): each stack copies the
whole as-is copy into its project, so they grow with the copy. On top of that come the installs: each release's `node_modules`,
the three toolchains (measured on the development machine: next 321 MB, mern 61 MB, react-vite 53 MB, so **~0.45 GB**) and
Playwright's Chromium. That is **probably 2–4 GB per release**. **Unsure**: I have not measured it on Linux, and the guide keeps 3 releases. Exact mode
(owner-only) refuses to start with less than 10 GB free.

**Recommendation:**

| Plan | vCPU | RAM | Disk (SSD) | Settings |
|---|---|---|---|---|
| Minimum (launch, low traffic) | 4 dedicated | 8 GB | 100 GB | `SAS_MAX_JOBS=1` |
| Comfortable | 8 dedicated | 16 GB | 200 GB | `SAS_MAX_JOBS=2`, later 3 |

- The other processes are small: the marketing site (**Unsure**: roughly 150–300 MB, not measured), Caddy (~50 MB) and the OS
  (~0.5 GB).
- HANDOFF says `SAS_MAX_JOBS=2` is safe on 8 GB "by those numbers". Two jobs side by side were never measured, so start at 1 and
  raise it only after watching memory (step 13).
- **Prefer dedicated or "CPU-optimised" vCPUs.** Lighthouse scores move with CPU noise. The analysis calibrates the CPU slowdown to
  how busy the machine is, but on a shared, noisy vCPU original-vs-copy comparisons get less steady.
- Add a 4 GB swap file (step 2) as a safety net against the kernel's OOM killer, not as working memory.

## 2. Base system

Run as a user with sudo on a fresh Ubuntu 24.04:

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y git curl ca-certificates gnupg ufw unzip sqlite3 \
  fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fonts-dejavu-core
sudo timedatectl set-timezone UTC

# Swap: a safety net only
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Firewall: SSH and the web only. Every app port (3000, 4000, the measurement servers 5100-5199,
# the stack previews and the other throwaway servers on random ports) stays on 127.0.0.1 and must not be opened.
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```

**Why fonts**: captures and copies are both rendered on this server, so they match each other whatever is installed. But a site
that falls back to system fonts (`system-ui`, `Arial`, CJK text, emoji) draws with whatever the server has. Without these
packages, captures show boxes or the wrong metrics. `npx playwright install-deps` (step 4) adds a few more fonts. Microsoft's
core fonts (`ttf-mscorefonts-installer`, which has its own licence prompt) are optional.

**A user for the app.** It runs as an unprivileged user and never as root:

```bash
sudo adduser --system --group --home /srv/sas --shell /bin/bash sas
sudo -u sas mkdir -p /srv/sas/{releases,site-releases,shared,data,tmp,backups-offsite}
```

Layout used below:

```
/srv/sas/releases/<tag>/    one checkout of the tool per release
/srv/sas/app -> releases/<tag>    the running release (symlink)
/srv/sas/site-releases/<tag>/    one checkout of the marketing site per release
/srv/sas/site -> site-releases/<tag>
/srv/sas/shared/api.env    the API's settings (linked into each release as server/.env)
/srv/sas/shared/site.env    the marketing site's settings
/srv/sas/data/    SAS_DATA_DIR: app.db, projects/, backups/, server.lock, copy-issues.log
/srv/sas/tmp/    SAS_TEMP_DIR: job scratch (same disk as data)
```

## 3. Node.js

Use **Node 24 LTS**. The development machine runs v24.21.0. The repo needs ≥ 22.13 for `node:sqlite` and `--env-file-if-exists`,
and Next.js 16 needs ≥ 20.9.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v24.x
```

No compiler is needed. SQLite is Node's built-in `node:sqlite`, and sharp, esbuild, Next's SWC and Playwright all ship
prebuilt Linux binaries.

## 4. Get the code and install it (first release)

Replace `<tool-repo-url>` / `<site-repo-url>` with your Git remotes and `<tag>` with the commit or tag you deploy.
**Unsure: which branch is the launch branch has not been decided.** The launch-readiness work (data lock, job limits, cleanup,
production refusal), the two fixes after this guide and the React + Vite / Next.js / MERN conversions are on `accounts`.

```bash
sudo -iu sas
cd /srv/sas/releases
git clone <tool-repo-url> <tag> && cd <tag> && git checkout <tag>

npm ci                                   # root + client + server workspaces, from package-lock.json
npm run build                            # the client → client/dist (base /app/)

# Chromium for Playwright and Lighthouse (Lighthouse launches Playwright's Chromium: audit/lighthouse/run.js)
npx -w server playwright install chromium
exit
# its system libraries need root, once per server (and again when Playwright's version changes):
sudo /srv/sas/releases/<tag>/node_modules/.bin/playwright install-deps chromium
```

**The build toolchains** for the React + Vite, Next.js and MERN copies. These are not server dependencies: each one is the
folder `server/toolchains/<id>/` of the release, with its own `package.json` and `package-lock.json` (both in git) and its own
`node_modules` (not in git).
The code finds a toolchain only there (`config/paths.js toolchainDir` = `<release>/server/toolchains/<id>`), and a build links
the copy's project to that `node_modules` for the time of the build, then removes the link. Nothing else is needed: no global
install, no environment setting. (In the development worktrees these `node_modules` folders are links to another checkout,
`Website-Audit-exact`; that is a development shortcut only. On the server, install them for real in every release. The setup
removes such a link, never what it points to, before it installs.)

Install all three, as the `sas` user, on the server itself (never copy `node_modules` from another machine: Next.js ships
a native compiler per platform). The setup runs `npm ci --ignore-scripts` in each folder: it installs exactly the committed
lockfile (every package, the ones underneath included, at a fixed version with its integrity hash) and refuses a lockfile that
does not match `package.json`; no package runs code at install. This needs the npm registry once:

```bash
sudo -iu sas
cd /srv/sas/releases/<tag>
npm run setup:toolchains -w server -- react-vite next mern
npm run setup:toolchains -w server       # no argument = status; all three must say "installed (…versions…)"
exit
```

The direct versions (`server/toolchains/<id>/package.json`; the lockfile next to it pins everything they pull in):

| Toolchain | Used for | Pinned packages | Pinned underneath (`overrides`) |
|---|---|---|---|
| `react-vite` | React + Vite copies (conversion, and the packed fallback) | vite 6.3.5, @vitejs/plugin-react 4.5.0, react + react-dom 19.1.0, gsap 3.15.0, motion 13.4.6 | rollup 4.40.2, framer-motion 13.4.6, motion-dom 13.4.5, motion-utils 13.3.0 |
| `next` | Next.js copies (`next build`, and `next start` for a packed copy's check) | next 15.5.27, react + react-dom 19.1.9, gsap 3.15.0, motion 13.4.6 | framer-motion 13.4.6, motion-dom 13.4.5, motion-utils 13.3.0 |
| `mern` | MERN copies (runs the copy's Express server during the checks; builds the client of a clean MERN stack) | the react-vite list + express 5.2.1, compression 1.8.2, mongodb 7.7.0 | as react-vite |

**Check they work** (as `sas`, in the release folder):

```bash
npm run setup:toolchains -w server                                              # all three "installed": every package as locked
node server/toolchains/react-vite/node_modules/vite/bin/vite.js --version       # vite/6.3.5 linux-x64 …
node server/toolchains/next/node_modules/next/dist/bin/next --version            # Next.js v15.5.27
node server/toolchains/mern/node_modules/vite/bin/vite.js --version             # vite/6.3.5 linux-x64 …
node -e "console.log(require('./server/toolchains/mern/node_modules/express/package.json').version)"   # 5.2.1
# A real build with no browser (temporary data folder, never /srv/sas/data; one at a time):
npm test -w server -- test/convert-react-build.test.js     # React + Vite: builds a converted copy, compares every page
npm test -w server -- test/copy-served.test.js             # Next.js: next build + next start of a packaged copy
npm test -w server -- test/convert-mern-build.test.js     # MERN: builds a converted copy, runs its Express server
npm test -w server -- test/toolchain-lock.test.js          # the lockfiles match package.json; the "installed" rule
```

If a toolchain is missing, a copy for that stack fails with "The <id> toolchain is not installed. Run: npm run setup:toolchains
-w server -- <id>" (`GET /api/stacks` also shows `toolchainInstalled` and the command). The conversions need no system package
beyond Node and no new setting in `api.env`: the build runs with a fixed, minimal environment (`build/toolchain.js`: telemetry
off, `CI=1`, `NODE_ENV=production`).

**"Installed" means installed as locked** (`toolchains/index.js lockedInstall`): every package of the lockfile is in
`node_modules` at its place with the locked version, and the lockfile still matches `package.json` and its `overrides`.
An optional package may be absent only when it is a native build for another system (or has no system at all, such as a wasm
fallback); this system's native build must be there. A different version anywhere = "not installed as locked", and the
status line names the package; run the setup again.

**Updating a toolchain** (a developer task, not a server one): change `package.json`, then write the lockfile again with
releases at least two weeks old, and commit both:

```bash
cd server/toolchains/<id>
npm install --package-lock-only --ignore-scripts --before=<date two weeks ago, e.g. 2026-10-11>
```

The lockfiles of 2026-10-25 were written with `--before=2026-10-11`: every package in them was published on or before that
day (for example the newer qs 6.16.1 of 2026-10-14 and caniuse-lite of 2026-10-13 were left out).

**Lighthouse** needs nothing beyond that Chromium. **Unsure (the one install step most likely to bite): Chromium's sandbox on
Ubuntu 24.04.** Playwright launches its own browsers with `--no-sandbox`, but Lighthouse's Chrome is started by
`chrome-launcher` without that flag (`audit/lighthouse/worker.js`). Ubuntu 24.04 restricts unprivileged user namespaces through
AppArmor, which Chromium's sandbox needs. Test once as the `sas` user:

```bash
sudo -iu sas
CHROME=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1); echo "$CHROME"
"$CHROME" --headless=new --disable-gpu --dump-dom about:blank && echo "Chromium starts with its sandbox: OK"
exit
```

If it fails with "No usable sandbox", give that binary an AppArmor profile that allows user namespaces. This is the same fix
Ubuntu documents for Chrome. Replace the path with the one printed above, using `*` for the version:

```bash
sudo tee /etc/apparmor.d/sas-playwright-chromium >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile sas-playwright-chromium /srv/sas/.cache/ms-playwright/chromium-*/chrome-linux*/chrome flags=(unconfined) {
  userns,
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/sas-playwright-chromium
```

(The blunt alternative, `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`, turns the protection off for the whole
machine. Prefer the profile.)

## 5. The API's settings: `/srv/sas/shared/api.env`

The server reads `server/.env` (`--env-file-if-exists=.env` in `npm start`), and so do `db:migrate`, `db:backup`, `cleanup`,
`accounts` and `mail:test`. So the file lives once in `shared/` and is linked into each release:

```bash
sudo -u sas touch /srv/sas/shared/api.env && sudo chmod 600 /srv/sas/shared/api.env
sudo -u sas ln -sfn /srv/sas/shared/api.env /srv/sas/releases/<tag>/server/.env
sudo -u sas nano /srv/sas/shared/api.env
```

Production values:

```ini
# --- Production refuses to start without these being right (config/index.js startupProblems, src/index.js) ---
NODE_ENV=production
SAS_ACCOUNTS=1
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=mailer@example.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx
MAIL_FROM=Remastly <mailer@example.com>

# --- Required in practice (the server starts without them, but things break) ---
SAS_PUBLIC_ORIGIN=https://example.com
APP_ORIGIN=https://example.com
SAS_OWNER_EMAIL=you@example.com
SAS_DATA_DIR=/srv/sas/data

# --- Where and how it runs ---
PORT=4000
SAS_BIND_HOST=127.0.0.1
SAS_TEMP_DIR=/srv/sas/tmp
SAS_KEEP_AWAKE=0

# --- Jobs (jobs/limits.js) ---
SAS_MAX_JOBS=1
SAS_JOBS_PER_USER=1
SAS_JOB_MAX_MINUTES=240
SAS_JOB_MIN_FREE_MB=2048

# --- Disk cleanup (jobs/cleanup.js) ---
SAS_KEEP_COPIES_DAYS=30
SAS_CLEANUP_HOURS=6
SAS_CLEANUP_DRY_RUN=1
```

Notes on these values:

- `SMTP_PASS`: for a Gmail account this is an app password, not the account password.
- `MAIL_FROM`: for Gmail, the same address as `SMTP_USER` (or an alias set up in Gmail).
- `SAS_PUBLIC_ORIGIN`: an `https:` value turns the cookie's `Secure` flag on and makes it `__Host-sas_session`. Without it the
  cookie is sent without `Secure`.
- `APP_ORIGIN`: the previews' `frame-ancestors`. A wrong value means the tool cannot frame previews.
- `SAS_OWNER_EMAIL`: read by `db:migrate`, which creates the owner account from it.
- `SAS_BIND_HOST`: Caddy runs on the same machine, so the API stays on loopback.
- `SAS_TRUST_PROXY`: leave it unset. The default, `loopback`, believes the visitor address Caddy passes on (it runs on this
  machine) and nobody else's. Set it only when the proxy runs elsewhere (its address or subnet, e.g. `10.0.0.5`).
- `SAS_KEEP_AWAKE`: keeping the machine awake is a laptop concern. On a server, `systemd-inhibit` is pointless.
- `SAS_MAX_JOBS`: start at 1, see section 1.
- `SAS_CLEANUP_DRY_RUN`: 1 for the first days, so cleanup only logs what it would remove. Then set it to 0.

**What production refuses to start with** (the log line starts with "Not starting:", and the process exits 1):

| Condition | Why |
|---|---|
| `NODE_ENV=production` without `SAS_ACCOUNTS=1` | with accounts off, every visitor is the owner |
| `SAS_ACCOUNTS=1` in production without `SMTP_HOST` | sign-ups could never be verified |
| SMTP set but `MAIL_FROM` not an address, `SMTP_PORT` not a port, or only one of `SMTP_USER` / `SMTP_PASS` | `mailProblems()` |
| `SAS_DEV_NO_VERIFY=1` with production or a non-loopback bind | development only. **Never set it here.** |
| `SAS_ALLOW_LOCALHOST=1` with a non-loopback `SAS_BIND_HOST` | it would let users point the tool at the server itself. **Never set it here.** |
| `SAS_ACCOUNTS=1` while the database has migrations to apply | run `npm run db:migrate -w server` first |
| another server already holds `<data>/server.lock` | one server per data folder |

**Leave unset** (defaults are right, or they are test switches):

- `SAS_TIMEOUT_SCALE`, `SAS_ANALYZE_MINUTES`, `SAS_RECREATE_MINUTES`, `SAS_RECREATE_OVERLAP`, `SAS_MAX_PARALLEL`. Set
  `SAS_MAX_PARALLEL=2` only if jobs run out of memory.
- `SAS_SHARED_CACHE`, `SAS_RECORD_MB`, `SAS_CAPTURE_PAGES`, `SAS_CRAWL_CONCURRENCY`.
- `SAS_COOKIE_SECURE`: follows `SAS_PUBLIC_ORIGIN`. Set it to 1 if you want to be explicit.
- Test switches, never in production: `SAS_NETWORK_WATCH`, `SAS_CORRECT`, `SAS_COPY_LINK_CHECK`.

The client needs no settings: it calls `/api` on its own origin. `VITE_API_BASE` only exists to move that.

## 6. The database: first migration

A new data folder gets its database the first time the server starts. With accounts on, that start then stops and asks for the
migration. The migration backs up, rehearses on a scratch copy and only then applies (`db/migrate.js`):

```bash
sudo -iu sas
cd /srv/sas/app 2>/dev/null || cd /srv/sas/releases/<tag>
npm start -w server
# expected: "Not starting: SAS_ACCOUNTS=1 needs the accounts tables, and the database has migrations to apply (...)"
npm run db:migrate -w server             # uses SAS_OWNER_EMAIL from server/.env
npm run accounts -w server               # lists accounts: the owner should be there, role owner
exit
```

**Unsure**: I read this order from the code (`db/index.js` gives a just-created database only its `required` migration) but did
not run it.

The owner account is created without a password. To sign in the first time, **sign up on the marketing site with that same
address**. The verification code arrives by mail, and the account keeps its owner role (`reclaimUser` sets only the password,
the verified date and the name).

`db:migrate` refuses while anything listens on 127.0.0.1:`PORT`. Always stop the API first (step 10 does).

## 7. The marketing site

`NEXT_PUBLIC_*` values are baked in at **build** time. `SITE_URL` is read when the pages are built, and also at runtime to be
safe.

```bash
sudo -u sas tee /srv/sas/shared/site.env >/dev/null <<'EOF'
NODE_ENV=production
SITE_URL=https://example.com
NEXT_PUBLIC_APP_URL=/app
NEXT_PUBLIC_API_BASE=/api
NEXT_PUBLIC_CONTACT_EMAIL=hello@example.com
NEXT_TELEMETRY_DISABLED=1
EOF

sudo -iu sas
cd /srv/sas/site-releases
git clone <site-repo-url> <tag> && cd <tag> && git checkout <tag>
npm ci
set -a && . /srv/sas/shared/site.env && set +a && npm run build
ln -sfn /srv/sas/site-releases/<tag> /srv/sas/site
exit
```

What these settings do:

- `SITE_URL`: canonical addresses, the sitemap, robots.txt and Open Graph images.
- `NEXT_PUBLIC_APP_URL`: where a signed-in visitor goes. **When it is empty, the sign-in forms say sign-in is not open and send
  nothing.**
- `NEXT_PUBLIC_API_BASE`: where the forms post.
- `NEXT_PUBLIC_CONTACT_EMAIL`: optional. While it is empty, no address is shown anywhere.

Before launch, also fill in the README's placeholders (`[PRICE]`, `[NUMBER]`, the pricing answers).

## 8. The two services (systemd)

**Plain stop-then-start only.** Jobs live in the memory of the process that runs them, and `<data>/server.lock` allows one
server per data folder. `systemctl restart` stops and then starts, which is correct. Never run a second API unit, a PM2 cluster
or a "reload" on the same data folder.

`/etc/systemd/system/sas-api.service`:

```ini
[Unit]
Description=Remastly tool API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sas
Group=sas
WorkingDirectory=/srv/sas/app/server
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/index.js
Restart=on-failure
RestartSec=10
# SIGTERM: the server stops its as-is previews and exits within 3 s (src/index.js shutdown). The whole control group,
# including every Chromium, is stopped with it.
KillMode=control-group
TimeoutStopSec=30
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/sas-site.service`:

```ini
[Unit]
Description=Remastly marketing site
After=network-online.target

[Service]
Type=simple
User=sas
Group=sas
WorkingDirectory=/srv/sas/site
EnvironmentFile=/srv/sas/shared/site.env
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The marketing site's own `npm start` binds to every address. The `-H 127.0.0.1` above keeps it behind Caddy.

```bash
sudo -u sas ln -sfn /srv/sas/releases/<tag> /srv/sas/app
sudo systemctl daemon-reload
sudo systemctl enable --now sas-site sas-api
journalctl -u sas-api -n 30 --no-pager
# expected: "Jobs: 1 at a time on this server, ..." and "API ready on http://127.0.0.1:4000 (this computer only)"
curl -s http://127.0.0.1:4000/api/health
```

**What a stop does to running work**:

- A queued job is put back in line in the same order on the next start (`requeueJobs`).
- A running **copy** continues by itself from its checkpoint (`autoResume`, at most 2 in a row). That happens once its heartbeat
  is seen as stale, up to about 2–4 minutes after the new start.
- A running **Analyze** or **Re-audit** is marked failed with "The server restarted while this job was running. Run it again."
- A `kill -9` or a crash leaves `server.lock` behind. The next start takes it over, because its pid is dead.

## 9. Caddy: one domain, automatic HTTPS

Point the domain's A record (and AAAA, if the server has IPv6) at the server **before** starting Caddy, so it can get its
certificate.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
{
	email you@example.com
}

www.example.com {
	redir https://example.com{uri} permanent
}

example.com {
	# The API and the previews of copies: one process. Caddy flushes Server-Sent Events (job progress) as they come and
	# sets X-Forwarded-Proto / X-Forwarded-Host, which the preview's content policy is built from. No compression here:
	# the API streams zips and events, and the previews set their own headers.
	handle /api/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle /preview/* {
		reverse_proxy 127.0.0.1:4000
	}

	# The tool: static files built with base /app/.
	redir /app /app/ 308
	handle /app/* {
		encode zstd gzip
		@hashed path /app/assets/*
		header @hashed Cache-Control "public, max-age=31536000, immutable"
		header @hashed -Last-Modified
		@notHashed not path /app/assets/*
		header @notHashed Cache-Control "no-cache"
		root * /srv/sas/app/client/dist
		uri strip_prefix /app
		try_files {path} /index.html
		file_server
	}

	# Everything else: the marketing site (Next.js compresses its own answers).
	handle {
		reverse_proxy 127.0.0.1:3000
	}

	log {
		output file /var/log/caddy/example.com.log
	}
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy      # Caddy itself can reload without downtime; only the API must not
```

**Signing in protects the data, not the files.** On a laptop, `scripts/local-proxy.mjs` also sends a signed-out visitor who
opens `/app/` to `/auth`. The Caddyfile above does not. The API refuses every route but `/api/health` and `/api/auth/*` without a
verified session (`accounts/gate.js`), and the app then sends the visitor to sign in itself (`client/src/api/base.js
goToSignIn`). The static bundle holds no secret. To send signed-out visitors to `/auth` straight away, replace the `/app/*` block
with this one.

**Unsure: not tested.** Also note that `/api/auth/me` answers 200 for a signed-in but unverified account, so those get through to
the app, and the API keeps them out.

```caddyfile
	handle /app/* {
		route {
			forward_auth 127.0.0.1:4000 {
				uri /api/auth/me
				@signedOut status 401
				handle_response @signedOut {
					redir * /auth?mode=signin&next={http.request.uri.path} 302
				}
			}
			encode zstd gzip
			root * /srv/sas/app/client/dist
			uri strip_prefix /app
			try_files {path} /index.html
			file_server
		}
	}
```

Because `/srv/sas/app` is a symlink, Caddy serves the new release's `client/dist` as soon as the link moves.

## 10. Updating and rolling back

Each release is a separate folder, so the new one is installed and built **while the old one keeps running**. Only the switch is
downtime: stop, migrate, move the symlink, start. That takes a minute or two.

```bash
NEW=<new-tag>
sudo -iu sas bash -lc "
  set -e
  cd /srv/sas/releases && git clone <tool-repo-url> $NEW && cd $NEW && git checkout $NEW
  npm ci && npm run build
  npx -w server playwright install chromium
  npm run setup:toolchains -w server -- react-vite next mern
  ln -sfn /srv/sas/shared/api.env server/.env
"
# only when this release moved to a new Playwright version:
sudo /srv/sas/releases/$NEW/node_modules/.bin/playwright install-deps chromium

# Wait for a quiet moment: busy=false means no job runs or waits. A running copy will continue after the restart;
# a running Analyze or Re-audit has to be started again.
curl -s http://127.0.0.1:4000/api/health

sudo systemctl stop sas-api
sudo -iu sas bash -lc "cd /srv/sas/releases/$NEW && npm run db:migrate -w server"   # backs up first; 'Nothing to migrate' is fine
sudo -u sas ln -sfn /srv/sas/releases/$NEW /srv/sas/app
sudo systemctl start sas-api
journalctl -u sas-api -n 30 --no-pager
```

Toolchain installs (`npm ci` in each `server/toolchains/<id>`, from its committed lockfile) are per release, and a cloned
release starts without them. Two releases with the same lockfiles get the same packages.
Keep the last 3 releases and delete older folders by hand.

The marketing site uses the same pattern: clone and build in `site-releases/<new>`, then
`ln -sfn …/site-releases/<new> /srv/sas/site && sudo systemctl restart sas-site`.

**Rolling back**:

```bash
sudo systemctl stop sas-api
sudo -u sas ln -sfn /srv/sas/releases/<previous-tag> /srv/sas/app
# Only if the new release ran a migration. Migrations go forward only (db/migrations.js has no "down");
# db:migrate wrote a backup before it changed anything:
ls -t /srv/sas/data/backups/ | head -3
#   then restore that file as in step 11, "Restoring"
sudo systemctl start sas-api
```

Restoring a pre-migration backup loses accounts, projects and jobs created after it. Copy folders made since then stay on disk,
and the cleanup removes folders no row knows after a day.

## 11. Backups

`npm run db:backup -w server` writes a consistent, integrity-checked copy (`VACUUM INTO`, safe while the server runs) to
`<data>/backups/app-<time>.db`. It never deletes old ones. The copies themselves (`<data>/projects/`) are plain files and need
their own off-machine copy.

`/etc/systemd/system/sas-backup.service`:

```ini
[Unit]
Description=Remastly database backup

[Service]
Type=oneshot
User=sas
WorkingDirectory=/srv/sas/app
ExecStart=/usr/bin/npm run db:backup -w server
ExecStartPost=/usr/bin/find /srv/sas/data/backups -name 'app-*.db' -mtime +14 -delete
```

`/etc/systemd/system/sas-backup.timer`:

```ini
[Unit]
Description=Remastly database backup, every 6 hours

[Timer]
OnCalendar=*-*-* 00/6:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now sas-backup.timer
sudo systemctl start sas-backup && journalctl -u sas-backup -n 20 --no-pager   # "Backup written: …" + row counts
```

**Off the machine.** The provider is not decided. Any tool that copies `/srv/sas/data/backups/` and `/srv/sas/data/projects/`
to another place on a schedule will do: provider snapshots, `restic` to object storage, or `rsync` to a second machine. Example
with rsync over SSH, run daily from the `sas` user's crontab (`crontab -e`):

```cron
30 3 * * * rsync -a --delete /srv/sas/data/backups/ backup@other-host:/backups/remastly/db/ && rsync -a /srv/sas/data/projects/ backup@other-host:/backups/remastly/projects/
```

**Restoring.** Test this once before launch (launch item L8):

```bash
sudo systemctl stop sas-api
cd /srv/sas/data
sudo -u sas mv app.db app.db.before-restore
sudo -u sas rm -f app.db-wal app.db-shm
sudo -u sas cp backups/app-<time>.db app.db
sudo -u sas sqlite3 app.db 'PRAGMA integrity_check;'   # ok
sudo systemctl start sas-api
```

`npm run db:rehearse -w server` shows what a migration would do to the current database, on a scratch copy, without changing it.

## 12. Mail

Before launch:

```bash
sudo -iu sas bash -lc 'cd /srv/sas/app && npm run mail:test -w server -- you@example.com'
```

It sends the real verification email with a meaningless code and prints the settings, never the password. If it times out, the
provider is probably blocking outbound 587 (see the top of this guide).

## 13. First-day checklist

- [ ] DNS for `example.com` and `www` points at the server; `https://example.com` shows the marketing site with a valid
      certificate.
- [ ] `curl -s http://127.0.0.1:4000/api/health` → `ok: true`, `jobs.limits` as set. `journalctl -u sas-api` shows no "Not
      starting".
- [ ] `https://example.com/api/health` answers through Caddy, and `https://example.com/app/` loads the tool. A signed-out
      visitor ends up on `/auth`.
- [ ] `npm run mail:test` mail arrived (check spam).
- [ ] Sign up with the owner address on the site. The code arrives, you land on `/app/`, and the owner-only "Advanced options"
      show in the Create step.
- [ ] In the browser's dev tools, the cookie is `__Host-sas_session` with `Secure`, `HttpOnly` and `SameSite=Lax`.
- [ ] Sign up a second, ordinary test account. It cannot see the owner's websites, and has no Advanced options. Delete it
      afterwards with `npm run accounts -w server -- delete <address> --yes`.
- [ ] Add a website you are authorised to use and run **Check**. It finishes, with Lighthouse phone + computer scores (if
      Lighthouse fails, see the sandbox note in step 4).
- [ ] Run **Create the copy** on one page. The preview shows in Compare, the re-audit runs after it, and the zip downloads.
- [ ] Build one copy as Next.js and one as React + Vite (the toolchains work).
- [ ] Watch memory during that copy (`free -m`, or `htop`): the lowest "available" figure tells you whether `SAS_MAX_JOBS=2`
      fits.
- [ ] `sudo systemctl restart sas-api` while a copy runs. It continues by itself within a few minutes (the
      restart-and-continue path).
- [ ] `sudo systemctl start sas-backup` works, a backup is restored once on a scratch copy, and the off-machine copy runs.
- [ ] After a few days, read `journalctl -u sas-api | grep '\[cleanup\]'`. If the dry-run list looks right, set
      `SAS_CLEANUP_DRY_RUN=0` and restart.
- [ ] `npm run cleanup -w server -- --dry-run` (with the API stopped, or it refuses) prints the disk table. Set a disk alert at
      80 %.
- [ ] Note the server's outbound IP. You will need it when a site blocks it.

## 14. Known risks

- **Sites blocking datacenter IPs** (L6). Bot protection, geo rules or plain stalls hit a VPS address much more often than a home
  connection. Cloudflare challenges fail with a clear message and are never bypassed. Seen from the development machine:
  `botza.panscience.xyz` stalled about 21 s and then `ERR_EMPTY_RESPONSE` (2026-10-23), and two sites had to be checked to see
  that they answered first. Keep the list HANDOFF asks for (site, host, what failed, why, date), from the production logs. There
  is no proxy pool or retry-from-another-IP in the code.
- **Gmail's sending limit** (L9). About 500 mails a day on a free account and about 2 000 on Workspace, and bursts get
  throttled. Every sign-up sends one mail, and an address can ask for at most 3 codes an hour and 6 a day. Move to a
  transactional mail provider (only the `SMTP_*` settings change) before the first marketing push, or when daily sign-ups
  approach a tenth of the cap.
- **Widgets that only allow the original's domain.** A chat widget, booking form or similar service in a copy may answer only
  the original's domain. For example, botza's API answers any other origin with `500 "Not allowed by CORS"`. The copy keeps the
  widget exactly, and the report names it as an open item: "only loads on the original's domain … will appear once your new
  domain is allowed in that service's settings" (`preserve/domainLock.js`). It is not fixable on our side. The same applies to
  the preview, which runs on `example.com`.
- **Sign-up limits behind Caddy (fixed after this guide was written).** Behind a proxy every visitor reaches the API from
  127.0.0.1. The API now believes `X-Forwarded-For` only from the proxies `SAS_TRUST_PROXY` names (default `loopback`), so the
  sign-up and failed sign-in limits count each real visitor, and nobody can choose their own address.
- **Stack previews of two jobs at once (fixed after this guide was written).** As-is stack previews used fixed ports 4501–4503;
  each run now gets a free port of its own, so `SAS_MAX_JOBS` ≥ 2 no longer collides on them.
- **Toolchain installs locked (fixed after this guide was written).** Each toolchain has a committed `package-lock.json`,
  installed with `npm ci`, and the status line holds `node_modules` against it. Still run the checks in step 4 after
  installing a release. Every downloaded project (React + Vite, Next.js, MERN client and server; converted, packed or clean)
  ships a `package-lock.json` per package, cut from the toolchain's lockfile (`toolchains/lockfile.js`), and its README and
  DEPLOY.md say `npm ci`: the owner installs exactly the packages the copy was built and checked with.
- **Next.js copies' `.next/` build folder (fixed after this guide was written).** It was kept with every Next.js copy (71 MB
  on a one-page copy) until retention removed the copy; the copy step now removes it once the copy is built and checked
  (`behavior/preserve/stage.js`, `convert/next.js dropBuildFolder`). The source and `out/` stay; `npm run dev` and
  `npm run build` of the download write their own.
- **Two jobs side by side were never measured for memory.** The 2.2 GB per job is one run, and the memory gate is per start, not
  per running job. Raise `SAS_MAX_JOBS` only after watching.
- **Waiting in line.** With one slot, the next person waits for the whole job in front: an as-is copy is about 20 minutes a page,
  and the backstop is `SAS_JOB_MAX_MINUTES` = 240. A per-plan page limit (`recreate_pages`) is the lever. See HANDOFF "The
  hold-up problem".
- **Restarts cost work.** A running Analyze or Re-audit has to be started again after any restart. A copy continues from its
  checkpoint.
- **Lighthouse numbers on a VPS** differ from PageSpeed Insights and from the laptop. The final proof (L11, one copy on a real
  static host compared in PageSpeed) is still open.
- **`/api/health` is public.** It tells anyone whether jobs are running and how many. It is harmless, but you can block it in
  Caddy (`@health path /api/health` → `respond @health 404`) if you prefer. Doing so would break the external uptime checks you
  point at it.
- **Previews.** A full navigation that a copy's own script makes to a root address leaves the preview, and a worker gets no shim
  (ACCOUNTS.md "Previews when hosted"). A MERN copy's preview is the client only: forms need the downloaded project's own server.
- **Launch items still open in HANDOFF**: L4 (per-plan concurrency), L5 (a hard per-page ceiling), L6, L7 (per-user disk quota),
  L9, L11, L12 (full test suite once before the PR). L1 (production refuses accounts off) and L2 (heartbeat + data lock) are
  done (`config/index.js startupProblems`,
  `config/dataLock.js`, `jobs/liveness.js`).
