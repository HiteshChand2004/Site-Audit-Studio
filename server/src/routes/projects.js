import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { db, projectDir } from '../db/index.js';
import { parseMaxPages } from './analyze.js';
import { buildDummyAudit } from '../dummy/audit.js';
import { precheckUrl } from '../security/netGuard.js';
import { MAX_RECREATE_PAGES, parseRecreatePages, parseTargetDomain } from '../recreate/inputs.js';
import { stopPreview } from '../recreate/preview.js';
import { recreateSection } from '../reaudit/contract.js';

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
  const blocked = precheckUrl(normalized);
  if (blocked) return badRequest(res, blocked);
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

  const { name, stack, url, max_pages: maxPages, recreate_pages: recreatePages, target_domain: targetDomain } = req.body ?? {};
  const next = {
    name: project.name,
    stack: project.stack,
    url: project.url,
    maxPages: project.max_pages,
    recreatePages: project.recreate_pages,
    targetDomain: project.target_domain,
  };

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
    const blocked = precheckUrl(normalized);
    if (blocked) return badRequest(res, blocked);
    next.url = normalized;
  }
  if (maxPages !== undefined) {
    const parsed = parseMaxPages(maxPages);
    if (!parsed) return badRequest(res, 'Max pages must be a whole number from 1 to 100.');
    next.maxPages = parsed;
  }
  if (recreatePages !== undefined) {
    const parsed = parseRecreatePages(recreatePages);
    if (parsed === null) return badRequest(res, `Recreate pages must be a whole number from 0 to ${MAX_RECREATE_PAGES}.`);
    next.recreatePages = parsed;
  }
  if (targetDomain !== undefined) {
    const parsed = parseTargetDomain(targetDomain);
    if (!parsed.ok) return badRequest(res, 'Target domain must be a domain or an http(s) origin, for example https://example.com.');
    next.targetDomain = parsed.value;
  }

  db.prepare(`
    UPDATE projects SET name = ?, stack = ?, url = ?, max_pages = ?, recreate_pages = ?, target_domain = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.stack, next.url, next.maxPages, next.recreatePages, next.targetDomain, new Date().toISOString(), project.id);
  res.json(toProject(selectOne.get(project.id)));
});

router.delete('/:id', async (req, res) => {
  const result = remove.run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found.' });
  await stopPreview({ projectId: req.params.id });
  await rm(projectDir(req.params.id), { recursive: true, force: true }).catch(() => {});
  res.status(204).end();
});

const latestAudit = db.prepare(`
  SELECT result_json FROM analyses
  WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL
  ORDER BY started_at DESC LIMIT 1
`);

// Latest completed analysis. Projects that were never analyzed get the labelled dummy audit.
// audit.recreate is the fix checklist of the latest re-audit (or the sample plus the re-audit state),
// built at read time: a stored analysis keeps the sample it was written with.
router.get('/:id/audit', (req, res) => {
  const project = selectOne.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const row = latestAudit.get(project.id);
  if (!row) return res.json(buildDummyAudit(project));
  const audit = JSON.parse(row.result_json);
  res.json({ ...audit, recreate: recreateSection(project, audit) });
});

export default router;
