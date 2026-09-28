# Site Audit Studio — Website Audit & Recreate Platform

Company ki saari websites ek jagah: audit (performance, SEO, AEO, accessibility, broken links, tech stack) aur improved version ka automatic recreate.

> ⚠️ Sirf company ki apni ya authorized websites par use karein.

## Prerequisites

- **Node.js ≥ 22.13** (built-in `node:sqlite` use hota hai, koi native build nahi)
- npm 10+

## Setup

```bash
npm install
```

## Run (development)

```bash
npm run dev
```

Ye ek saath dono start karta hai:

| Service | URL | Notes |
|---|---|---|
| Client (React + Vite) | http://localhost:5173 | Browser me yahi kholein |
| Server (Express API) | http://localhost:4000 | `/api/*`; client Vite proxy se call karta hai |

Alag-alag chalana ho to:

```bash
npm run dev:server   # sirf API, port 4000 (auto-restart on file change)
npm run dev:client   # sirf UI, port 5173
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
data/            SQLite DB (app.db) — auto-created, gitignored
```

## API (Phase 1)

| Method | Route | Body |
|---|---|---|
| GET | `/api/projects` | — |
| POST | `/api/projects` | `{ url, name?, authorized: true }` |
| GET | `/api/projects/:id` | — |
| PATCH | `/api/projects/:id` | `{ name?, url?, stack? }` — stack: `html`, `react-vite`, `nextjs`, `mern` |
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

Phase 1 me audit report, metrics, preview aur fix checklist **dummy data** hain. Analyze, Recreate aur Download buttons disabled hain.
