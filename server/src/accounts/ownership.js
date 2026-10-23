// @ts-check
// Whose project it is, while SAS_ACCOUNTS=1. Mounted in src/index.js on /api/projects/:id after the gate, so EVERY route of a
// project — the project itself, PATCH, delete, analyze, recreate, stop, export, re-audit, preview, as-is preview, the SSE streams,
// screenshots, captures, fidelity and exact images, downloads, reports, the page list and the favicon — first checks that the
// signed-in account owns it. A project of someone else answers exactly like a project that does not exist (404 "Project not
// found."), never 403, so ids cannot be probed. The routes behind it already tie every sub-id (analysis, copy, re-audit) to the
// project in the path, so owning the project is owning what is under it.
// A project with no owner (created with accounts off, or by a script) belongs to nobody here and is not shown to anyone.
import { db } from '../db/index.js';

const owned = db.prepare('SELECT id FROM projects WHERE id = ? AND owner_id = ?');

/** @type {import('express').RequestHandler} */
export function projectGate(req, res, next) {
  const user = /** @type {any} */ (req).user;
  if (!user || !owned.get(req.params.id, user.id)) return res.status(404).json({ error: 'Project not found.' });
  next();
}

/** How many projects belong to nobody (shown once at start, so a project made with accounts off is not silently lost). */
export const unownedProjects = () => Number(/** @type {any} */ (db.prepare('SELECT count(*) AS n FROM projects WHERE owner_id IS NULL').get()).n);
