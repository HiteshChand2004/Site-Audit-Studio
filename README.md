# Site Audit Studio — Website Audit & Recreate Platform

Manage all company websites in one place: audit them (performance, SEO, AEO, accessibility, broken links, tech stack) and automatically recreate an improved version.

> ⚠️ Use this tool only on company-owned or authorized websites.

## Prerequisites

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; no native build step)
- npm 10+

## Setup

```bash
npm install
npx -w server playwright install chromium   # one-time: browser for rendering, axe and Lighthouse
```

## Run (development)

```bash
npm run dev
```

This starts both services together:

| Service | URL | Notes |
|---|---|---|
| Client (React + Vite) | http://localhost:5173 | Open this in the browser |
| Server (Express API) | http://localhost:4000 | `/api/*`; the client calls it through the Vite proxy |

To run them separately:

```bash
npm run dev:server   # API only, port 4000 (restarts on file change)
npm run dev:client   # UI only, port 5173
```

Other commands:

```bash
npm run build        # client production build → client/dist
npm start            # server without watch mode
npm test -w server   # server unit tests (node --test)
npm run fixture-site -w server   # seeded test site on http://localhost:4100
```

Health check: `curl http://localhost:4000/api/health`

## Project structure

```
client/          React + Vite UI (3-column layout: sidebar, OLD panel, NEW panel)
  src/layout/        AppShell, Sidebar, OldPanel, NewPanel
  src/components/    common/, audit/, preview/, project/, recreate/
  src/store/         Zustand store (projects, selection, audit)
  src/styles/        design tokens + global styles
server/          Express API
  src/db/            node:sqlite setup + schema (projects, analyses)
  src/routes/        /api/projects, analyze + SSE
  src/audit/         Analyze pipeline: crawler, link checker, render + axe, Lighthouse worker, analyzers
  src/detection/     stack detection engine + rules/<platform>.json, manual-rebuild detector
  src/dummy/         dummy audit (shown until a project is analyzed)
  test/              unit tests + fixture site
data/            SQLite database (app.db) + projects/<id>/audit/<analysisId>/ raw artifacts; gitignored
```

## API

| Method | Route | Body |
|---|---|---|
| GET | `/api/projects` | — |
| POST | `/api/projects` | `{ url, name?, authorized: true }` |
| GET | `/api/projects/:id` | — |
| PATCH | `/api/projects/:id` | `{ name?, url?, stack?, max_pages? }`, where stack is `html`, `react-vite`, `nextjs` or `mern` and max_pages is 1–100 |
| DELETE | `/api/projects/:id` | — |
| GET | `/api/projects/:id/audit` | — (latest completed analysis; dummy data until the first one) |
| POST | `/api/projects/:id/analyze` | `{ maxPages? }` → 202 `{ analysisId, job, steps }`, 409 if one is already running |
| GET | `/api/projects/:id/analyze/current` | — (running/queued job or `null`) |
| GET | `/api/projects/:id/analyze/:analysisId/events` | — (SSE: `progress`, `done`, `failed`) |

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Layout, sidebar, project save/list, stack settings | ✅ Done |
| 2 | Analyze: Lighthouse, stack detection, crawler, SEO/AEO/a11y | ✅ Done |
| 3 | OLD panel iframe + screenshot / live-view fallback | ⏳ |
| 4 | Recreate (plain HTML), motion + responsive fidelity | ⏳ |
| 5 | NEW panel preview server + fix checklist | ⏳ |
| 6 | Other stacks + Download zip | ⏳ |

Analyze is real (Phase 2). The OLD preview wireframe, the NEW panel preview and the fix checklist are still **sample data**, and Recreate and Download are disabled.
