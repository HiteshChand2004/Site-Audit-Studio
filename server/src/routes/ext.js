// @ts-check
// The API Growth OS calls (docs/GROWTHOS-INTEGRATION.md): server to server, with a key (SAS_GROWTHOS_KEY), not a person's
// session, so it is mounted before the accounts gate. Nothing here approves or publishes: that is a person's, in Remastly.
import { timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { callbackAllowed, growthosKey } from '../changes/config.js';
import { ContractError, parseChangeRequest } from '../changes/contract.js';
import { findProject, resolveBase, SiteError } from '../changes/site.js';
import { changeRow, changesReady, viewChange } from '../changes/store.js';
import { cancelChange, DecisionError, previewOf, submitChange } from '../changes/worker.js';
import { BriefError, briefView, sentBrief, submitBrief } from '../buildmode/briefs.js';

export const extRouter = Router();
extRouter.use(express.json({ limit: '256kb' }));

const same = (/** @type {string} */ a, /** @type {string} */ b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// The key first: without it, nothing (not even whether a website exists) is answered.
extRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const key = growthosKey();
  if (!key) return res.status(503).json({ error: 'The Growth OS link is not set up on this Remastly (SAS_GROWTHOS_KEY).' });
  const sent = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!sent || !same(sent, key)) return res.status(401).json({ error: 'Wrong or missing key.' });
  if (!changesReady()) return res.status(503).json({ error: 'This Remastly\'s database has no change tables yet; restart it once (it adds them by itself).' });
  next();
});

/** What Growth OS sees of a change. @param {any} row */
const shown = (row) => {
  const c = /** @type {any} */ (viewChange(row));
  return {
    id: c.id, requestId: c.requestId, type: c.type, status: c.status, step: c.step, message: c.message, page: c.page,
    previewUrl: previewOf(row) ?? c.previewUrl, liveUrl: c.liveUrl, publishedAt: c.publishedAt, score: c.score, checks: c.checks, notes: c.notes,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
};

extRouter.get('/sites', async (req, res) => {
  const project = findProject({ projectId: typeof req.query.projectId === 'string' ? req.query.projectId : null, siteUrl: typeof req.query.url === 'string' ? req.query.url : '' });
  if (!project) return res.status(404).json({ error: 'No website in Remastly with that address.' });
  let canChange = true;
  let reason;
  try {
    await resolveBase(project);
  } catch (err) {
    canChange = false;
    reason = /** @type {Error} */ (err).message;
  }
  res.json({ projectId: project.id, name: project.name, url: project.url, canChange, ...(reason && { reason }) });
});

extRouter.post('/change-requests', (req, res) => {
  try {
    const parsed = parseChangeRequest(req.body);
    const { row, existing } = submitChange(parsed, { callbackCheck: callbackAllowed });
    res.status(existing ? 200 : 202).json(shown(row));
  } catch (err) {
    if (err instanceof ContractError) return res.status(400).json({ error: err.message });
    if (err instanceof SiteError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

extRouter.get('/change-requests/:id', (req, res) => {
  const row = changeRow(req.params.id);
  if (!row || row.source !== 'growth-os') return res.status(404).json({ error: 'No such change.' });
  res.json(shown(row));
});

extRouter.post('/change-requests/:id/cancel', (req, res) => {
  const row = changeRow(req.params.id);
  if (!row || row.source !== 'growth-os') return res.status(404).json({ error: 'No such change.' });
  try {
    res.json(shown(cancelChange(row.id)));
  } catch (err) {
    if (err instanceof DecisionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// ---- Website prompts for Build mode (buildmode/briefs.js): one prompt for a whole website becomes a saved site of Build mode
// for the website's owner, described and waiting; the owner opens it (openUrl) and presses Continue. Nothing is planned or built here.
extRouter.post('/site-briefs', async (req, res, next) => {
  try {
    const { site, existing } = await submitBrief(req.body);
    res.status(existing ? 200 : 201).json(await briefView(site));
  } catch (err) {
    if (err instanceof BriefError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

extRouter.get('/site-briefs/:id', async (req, res, next) => {
  try {
    const site = await sentBrief(req.params.id);
    if (!site) return res.status(404).json({ error: 'No such website prompt.' });
    res.json(await briefView(site));
  } catch (err) {
    next(err);
  }
});
