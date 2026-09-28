import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { buildDummyAudit } from '../dummy/audit.js';

export const STACKS = ['html', 'react-vite', 'nextjs', 'mern'];

const router = Router();

const toProject = (row) => row && { ...row, authorized: Boolean(row.authorized) };

function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    const validHost = url.hostname.includes('.') || url.hostname === 'localhost';
    if (!['http:', 'https:'].includes(url.protocol) || !validHost) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

const selectAll = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC');
const selectOne = db.prepare('SELECT * FROM projects WHERE id = ?');
const insert = db.prepare(`
  INSERT INTO projects (id, name, url, stack, authorized, created_at, updated_at)
  VALUES (?, ?, ?, ?, 1, ?, ?)
`);
const remove = db.prepare('DELETE FROM projects WHERE id = ?');

router.get('/', (_req, res) => {
  res.json(selectAll.all().map(toProject));
});

router.post('/', (req, res) => {
  const { name, url, authorized } = req.body ?? {};
  const normalized = normalizeUrl(url);
  if (!normalized) return badRequest(res, 'A valid http(s) URL is required.');
  if (authorized !== true) {
    return badRequest(res, 'Please confirm you are authorized to audit and recreate this site.');
  }
  const displayName = (typeof name === 'string' && name.trim()) || new URL(normalized).hostname;
  const now = new Date().toISOString();
  const id = randomUUID();
  insert.run(id, displayName.slice(0, 120), normalized, 'html', now, now);
  res.status(201).json(toProject(selectOne.get(id)));
});

router.get('/:id', (req, res) => {
  const project = selectOne.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(toProject(project));
});

router.patch('/:id', (req, res) => {
  const project = selectOne.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const { name, stack, url } = req.body ?? {};
  const next = { name: project.name, stack: project.stack, url: project.url };

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return badRequest(res, 'Name cannot be empty.');
    next.name = name.trim().slice(0, 120);
  }
  if (stack !== undefined) {
    if (!STACKS.includes(stack)) return badRequest(res, `Stack must be one of: ${STACKS.join(', ')}`);
    next.stack = stack;
  }
  if (url !== undefined) {
    const normalized = normalizeUrl(url);
    if (!normalized) return badRequest(res, 'A valid http(s) URL is required.');
    next.url = normalized;
  }

  db.prepare('UPDATE projects SET name = ?, stack = ?, url = ?, updated_at = ? WHERE id = ?')
    .run(next.name, next.stack, next.url, new Date().toISOString(), project.id);
  res.json(toProject(selectOne.get(project.id)));
});

router.delete('/:id', (req, res) => {
  const result = remove.run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found.' });
  res.status(204).end();
});

// Phase 1: dummy data. The real audit pipeline replaces this in Phase 2.
router.get('/:id/audit', (req, res) => {
  const project = selectOne.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(buildDummyAudit(project));
});

export default router;
