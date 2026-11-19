// @ts-check
// POST /api/batch-fixes { projectIds? } starts "Apply the latest fixes" on every site of the signed-in account (or those given);
// GET returns its progress (null = none); DELETE stops it (starts no more). Open to every user for their own sites, as the button is.
import { Router } from 'express';
import { db } from '../db/index.js';
import { batches, createBatch } from '../recreate/batchFixes.js';

const router = Router();
const allProjects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC');
// owner_id exists only with accounts on (routes/projects.js prepares it the same way, only when needed).
let ownedProjects;
const owned = (owner) => (ownedProjects ??= db.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC')).all(owner);
const ownerOf = (req) => /** @type {any} */ (req).user?.id ?? null;

router.get('/', (req, res) => res.json({ batch: batches.get(ownerOf(req))?.batch ?? null }));

router.post('/', async (req, res) => {
  const owner = ownerOf(req);
  if (batches.get(owner) && !batches.get(owner).batch.finishedAt) return res.status(409).json({ error: 'Fixes are already being applied to your sites.' });
  let projects = owner ? owned(owner) : allProjects.all();
  if (Array.isArray(req.body?.projectIds)) {
    const ids = new Set(req.body.projectIds.filter((x) => typeof x === 'string'));
    projects = projects.filter((p) => ids.has(p.id));
  }
  if (!projects.length) return res.status(400).json({ error: 'There is no site to apply the fixes to.' });
  const run = createBatch({ ownerId: owner, projects });
  batches.set(owner, run);
  await run.tick();
  res.status(202).json({ batch: run.batch });
});

router.delete('/', async (req, res) => {
  const run = batches.get(ownerOf(req));
  if (!run || run.batch.finishedAt) return res.status(409).json({ error: 'Nothing is being applied.' });
  await run.stop();
  res.json({ batch: run.batch });
});

export default router;
