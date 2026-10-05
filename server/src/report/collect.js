// Everything the report needs, read from the database and the project folder: the project, the latest analysis
// (the audit as the OLD panel shows it), the latest completed recreate (its report.json), the fix checklist of the
// latest re-audit (audit.recreate) and small screenshots of the original and the recreated pages.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db, projectDir } from '../db/index.js';
import { recreateSection } from '../reaudit/contract.js';
import { recreateDir } from '../recreate/workspace.js';
import { buildDummyAudit } from '../dummy/audit.js';

const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const latestAudit = db.prepare(`
  SELECT result_json FROM analyses WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL ORDER BY started_at DESC LIMIT 1
`);
const latestRecreate = db.prepare(`
  SELECT id, result_json FROM recreates WHERE project_id = ? AND status = 'done' AND result_json IS NOT NULL ORDER BY started_at DESC LIMIT 1
`);

// Report thumbnails: small (the report shows them at half this width, so they stay sharp on high-density screens
// without making the file or the page big): the width in px and the share of the width that makes the first screen.
// Desktop only for now (recreate/views.js); tablet { width: 250, ratio: 1024 / 768 } and mobile { width: 152, ratio: 812 / 375 } are parked.
const THUMB = {
  desktop: { width: 480, ratio: 900 / 1440 },
};

/** A WebP data URI of the top of a screenshot, or null when the file is missing. */
export async function thumbnail(file, view) {
  try {
    const { width, ratio } = THUMB[view];
    // Read into memory first: sharp keeps a handle on files it opens by path, and Windows cannot delete them then.
    const buffer = await readFile(file);
    const resized = await sharp(buffer).resize({ width }).toBuffer({ resolveWithObject: true });
    const height = Math.min(resized.info.height, Math.round(width * ratio));
    const out = await sharp(resized.data).extract({ left: 0, top: 0, width, height }).webp({ quality: 72 }).toBuffer();
    return `data:image/webp;base64,${out.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} projectId
 * @returns {Promise<null | { generatedAt: string, project: object, audit: object, analyzed: boolean, recreate: object|null, images: object }>}
 */
export async function collectReport(projectId) {
  const project = selectProject.get(projectId);
  if (!project) return null;

  const row = latestAudit.get(projectId);
  const analyzed = !!row;
  const audit = row ? JSON.parse(row.result_json) : buildDummyAudit(project);
  if (row) audit.recreate = recreateSection(project, audit);

  const rec = latestRecreate.get(projectId);
  const recreate = rec ? { ...JSON.parse(rec.result_json), recreateId: rec.id } : null;
  const images = { old: {}, new: {} };

  // The original: the first-screen shots of the analysis (screens/<view>-fold.webp).
  if (analyzed && audit.screenshots?.analysisId) {
    const dir = path.join(projectDir(projectId), 'audit', audit.screenshots.analysisId, 'screens');
    for (const view of Object.keys(THUMB)) images.old[view] = await thumbnail(path.join(dir, `${view}-fold.webp`), view);
  }
  // The recreated homepage: its screenshots from the fidelity check.
  if (recreate?.pages?.length) {
    const home = recreate.pages[0];
    const dir = path.join(recreateDir(projectId, rec.id), 'fidelity', home.slug ?? '');
    for (const view of Object.keys(THUMB)) images.new[view] = await thumbnail(path.join(dir, `${view}-full.webp`), view);
  }

  return {
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      url: project.url,
      stack: project.stack,
      targetDomain: project.target_domain ?? null,
      createdAt: project.created_at,
    },
    audit,
    analyzed,
    recreate,
    images,
  };
}
