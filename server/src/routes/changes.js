// @ts-check
// The app's side of the Growth OS changes: a website's list, one change with its checks and pictures, and the person's
// decision (approve → it goes live; turn down). Behind the accounts gate like every project route.
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { Router } from 'express';
import { db } from '../db/index.js';
import { growthosKey, growthosOrigin, growthosSecret, publishMode } from '../changes/config.js';
import { changeShotsDir } from '../changes/site.js';
import { callbacksOf, changeRow, changesReady, listChanges, viewChange } from '../changes/store.js';
import { approveChange, DecisionError, previewOf, rejectChange } from '../changes/worker.js';
import { publishTarget } from '../changes/publish.js';

export const changesRouter = Router();

const selectProject = db.prepare('SELECT id, name FROM projects WHERE id = ?');
const ownerKeyOf = (/** @type {any} */ req) => (req?.user?.id ? String(req.user.id) : 'local');
const byOf = (/** @type {any} */ req) => req?.user?.email ?? 'the team';

/** @param {any} row */
const shown = (row) => ({ ...viewChange(row), previewUrl: previewOf(row) ?? row.preview_url });

changesRouter.get('/:id/changes', async (req, res) => {
  const project = selectProject.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const link = { key: Boolean(growthosKey()), secret: Boolean(growthosSecret()), growthos: growthosOrigin(), publish: publishMode() ?? 'auto' };
  if (!changesReady()) return res.json({ ready: false, link, changes: [] });
  let target = null;
  try {
    const t = await publishTarget(req.params.id, ownerKeyOf(req));
    target = t.kind === 'local' ? 'local' : t.provider;
  } catch (err) {
    target = { error: /** @type {Error} */ (err).message };
  }
  res.json({ ready: true, link, target, changes: listChanges(req.params.id).map(shown) });
});

const own = (/** @type {any} */ req) => {
  const row = changeRow(req.params.changeId);
  return row && row.project_id === req.params.id ? row : null;
};

changesRouter.get('/:id/changes/:changeId', (req, res) => {
  const row = own(req);
  if (!row) return res.status(404).json({ error: 'No such change.' });
  res.json({ change: shown(row), callbacks: callbacksOf(row.id) });
});

changesRouter.post('/:id/changes/:changeId/approve', (req, res) => {
  const row = own(req);
  if (!row) return res.status(404).json({ error: 'No such change.' });
  if (row.status !== 'ready') return res.status(409).json({ error: `Only a change that is ready can be approved (this one is ${row.status}).` });
  // Going live can take minutes (Netlify): the app follows the row.
  approveChange(row.id, { by: byOf(req), ownerKey: ownerKeyOf(req) }).catch((err) => console.error(`[change ${row.id}] approve`, err));
  res.status(202).json({ change: shown(changeRow(row.id)) });
});

changesRouter.post('/:id/changes/:changeId/reject', (req, res) => {
  const row = own(req);
  if (!row) return res.status(404).json({ error: 'No such change.' });
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    res.json({ change: shown(rejectChange(row.id, { by: byOf(req), reason })) });
  } catch (err) {
    if (err instanceof DecisionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

changesRouter.get('/:id/changes/:changeId/shots/:name', async (req, res) => {
  const row = own(req);
  if (!row || !/^(desktop|phone)\.webp$/.test(req.params.name)) return res.status(404).end();
  const file = path.join(changeShotsDir(row.project_id, row.id), req.params.name);
  if (!(await stat(file).catch(() => null))?.isFile()) return res.status(404).end();
  res.set('Cache-Control', 'no-store').type('image/webp').sendFile(file);
});
