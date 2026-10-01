import { Router } from 'express';
import { collectReport } from '../report/collect.js';
import { renderReportHtml, reportFileName } from '../report/render.js';

const router = Router();

// The complete report of a project: the original site (OLD panel), the recreated site (NEW panel) and the fix
// checklist, as one self-contained HTML file (?format=html, the default) or as JSON (?format=json). With
// ?download=1 the response is an attachment. Built on request from what is stored; nothing is kept.
router.get('/:id/report', async (req, res, next) => {
  try {
    const data = await collectReport(req.params.id);
    if (!data) return res.status(404).json({ error: 'Project not found.' });
    const json = req.query.format === 'json';
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // The report has no script and loads nothing: if it is opened directly, it stays that way.
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    });
    if (req.query.download === '1') {
      res.set('Content-Disposition', `attachment; filename="${reportFileName(data.project, json ? 'json' : 'html')}"`);
    }
    if (json) {
      const { images, ...rest } = data; // screenshots are for the HTML report only
      void images;
      return res.type('application/json').send(JSON.stringify(rest, null, 1));
    }
    return res.type('text/html; charset=utf-8').send(renderReportHtml(data));
  } catch (err) {
    return next(err);
  }
});

export default router;
