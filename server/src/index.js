// First: settings the server must not start with stop it before any module opens the database (config/startup.js).
import './config/startup.js';
import express from 'express';
import cors from 'cors';
import projectsRouter from './routes/projects.js';
import analyzeRouter from './routes/analyze.js';
import screensRouter from './routes/screens.js';
import recreateRouter from './routes/recreate.js';
import reauditRouter from './routes/reaudit.js';
import stacksRouter from './routes/stacks.js';
import reportRouter from './routes/report.js';
import faviconRouter from './routes/favicon.js';
import { lockBusy } from './jobs/manager.js';
import { awakeHeld } from './jobs/keepAwake.js';
import { recoverStaleJobs, watchStaleJobs } from './recreate/jobs.js';
import { holdDataLock } from './config/dataLock.js';
import { stopAllAsIsPreviews } from './recreate/behavior/preserve/asisPreview.js';
import { accountsEnabled, bindHost, isLoopbackHost } from './config/index.js';
import { db } from './db/index.js';
import { pendingMigrations } from './db/apply.js';

const PORT = Number(process.env.PORT) || 4000;
// Who can reach the API: this computer only by default (SAS_BIND_HOST, config/index.js).
const HOST = bindHost();
// One server per data folder (config/dataLock.js): a second one on the same app.db exits here with who holds it. Before any job
// row is touched; the modules above only opened the database and applied its schema.
holdDataLock({ port: PORT });
const app = express();

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
app.use(express.json({ limit: '1mb' }));

// Accounts (SAS_ACCOUNTS=1): the database must have the accounts tables (npm run db:migrate), the auth routes are mounted, and
// every other /api route but /api/health is behind a verified session (accounts/gate.js). Off: none of this exists, as before.
// The modules are loaded only when on: they prepare statements on tables an unmigrated database does not have.
let accounts = null;
if (accountsEnabled()) {
  const pending = pendingMigrations(db);
  if (pending.length) {
    console.error(`Not starting: SAS_ACCOUNTS=1 needs the accounts tables, and the database has migrations to apply (${pending.map((m) => m.id).join(', ')}). `
      + 'Run "npm run db:migrate -w server" first (it backs up and rehearses before it changes anything).');
    process.exit(1);
  }
  const [{ default: authRouter }, { apiGate }, { originCheck }, { projectGate, unownedProjects }] = await Promise.all([
    import('./accounts/routes.js'), import('./accounts/gate.js'), import('./accounts/http.js'), import('./accounts/ownership.js'),
  ]);
  accounts = { authRouter, apiGate, originCheck, projectGate };
  const unowned = unownedProjects();
  if (unowned) console.warn(`Accounts: ${unowned} project(s) have no owner and are shown to nobody (made with accounts off?).`);
  app.use('/api', originCheck);
}

// busy: an Analyze, Recreate or Re-audit job is running or queued (the dev runner waits before restarting).
// keepAwake: the computer is being kept awake for it (jobs/keepAwake.js).
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, phase: '5', time: new Date().toISOString(), busy: lockBusy(), keepAwake: awakeHeld() });
});

if (accounts) {
  app.use('/api/auth', accounts.authRouter);
  app.use('/api', accounts.apiGate);
  // Every route of one project, files and streams included: only its owner gets past (404 for anyone else).
  app.use('/api/projects/:id', accounts.projectGate);
}

app.use('/api/projects', projectsRouter);
app.use('/api/projects', analyzeRouter);
app.use('/api/projects', screensRouter);
app.use('/api/projects', recreateRouter);
app.use('/api/projects', reauditRouter);
app.use('/api/projects', reportRouter);
app.use('/api/projects', faviconRouter);
app.use('/api/stacks', stacksRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

// The app shuts down: its previews of as-is copies stop with it (behavior/preserve/asisPreview.js).
const shutdown = () => {
  stopAllAsIsPreviews().catch(() => {}).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Express 5 passes listen errors (such as a port conflict) to this callback.
app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the other server or set PORT.` : err);
    process.exit(1);
  }
  console.log(`API ready on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}${isLoopbackHost(HOST) ? ' (this computer only)' : ' (reachable from the network)'}`);
  // Jobs a server that is gone left queued or running (their heartbeat stopped, jobs/liveness.js) are marked failed, and a
  // recreate among them continues where it stopped (recreate/checkpoint.js); then the same check keeps running. A job alive in
  // another process is never touched.
  recoverStaleJobs()
    .catch((e) => console.warn('Interrupted jobs not recovered:', e.message))
    .finally(() => watchStaleJobs());
});
