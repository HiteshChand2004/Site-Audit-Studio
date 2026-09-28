# Site Audit Studio — Website Audit & Recreate Platform

Manage all company websites in one place: audit them (performance, SEO, AEO, accessibility, broken links, tech stack) and automatically recreate an improved version.

> ⚠️ Use this tool only on company-owned or authorized websites.

## Prerequisites

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; no native build step)
- npm 10+

## Setup

```bash
npm install
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
  src/db/            node:sqlite setup + schema
  src/routes/        /api/projects
  src/dummy/         Phase 1 dummy audit data
data/            SQLite database (app.db), auto-created and gitignored
```

## API (Phase 1)

| Method | Route | Body |
|---|---|---|
| GET | `/api/projects` | — |
| POST | `/api/projects` | `{ url, name?, authorized: true }` |
| GET | `/api/projects/:id` | — |
| PATCH | `/api/projects/:id` | `{ name?, url?, stack? }`, where stack is `html`, `react-vite`, `nextjs` or `mern` |
| DELETE | `/api/projects/:id` | — |
| GET | `/api/projects/:id/audit` | — (Phase 1: dummy data) |

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Layout, sidebar, project save/list, stack settings | ✅ Done |
| 2 | Analyze: Lighthouse, stack detection, crawler, SEO/AEO/a11y | ⏳ |
| 3 | OLD panel iframe + screenshot / live-view fallback | ⏳ |
| 4 | Recreate (plain HTML), motion + responsive fidelity | ⏳ |
| 5 | NEW panel preview server + fix checklist | ⏳ |
| 6 | Other stacks + Download zip | ⏳ |

In Phase 1 the audit report, metrics, preview and fix checklist use **dummy data**. The Analyze, Recreate and Download buttons are disabled.
