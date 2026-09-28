import { Router } from 'express';
import path from 'node:path';
import { db, projectDir } from '../db/index.js';
import { SCREEN_FILE, screensDir } from '../audit/screenshots.js';
import { KEEP_SCREENSHOTS } from '../audit/retention.js';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const selectAnalysis = db.prepare('SELECT id FROM analyses WHERE id = ? AND project_id = ?');

// Screenshots of one analysis. The analysis id is part of the path, so a file never changes.
router.get('/:id/analyses/:analysisId/screens/:file', (req, res) => {
  const { id, analysisId, file } = req.params;
  if (!UUID.test(id) || !UUID.test(analysisId) || !SCREEN_FILE.test(file)) {
    return res.status(404).json({ error: 'Screenshot not found.' });
  }
  if (!selectAnalysis.get(analysisId, id)) return res.status(404).json({ error: 'Analysis not found.' });

  const filePath = path.join(screensDir(path.join(projectDir(id), 'audit', analysisId)), file);
  res.sendFile(
    filePath,
    {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    },
    (err) => {
      if (!err || res.headersSent) return;
      res.status(404).json({
        error: `Screenshot not found. Only the latest ${KEEP_SCREENSHOTS} analyses of a project keep their screenshots.`,
      });
    },
  );
});

export default router;
