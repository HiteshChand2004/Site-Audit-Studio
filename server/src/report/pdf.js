// The report as a PDF, made by the Chromium the rest of the app already uses: the HTML report is loaded from memory
// (no network: every image is inline, the page has no script) and printed to A4 with page numbers. One PDF at a time,
// so several clicks do not start several browsers.
import { launchBrowser } from '../audit/render.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let queue = Promise.resolve();

async function build(html, title) {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1000, height: 1400 } });
    // Nothing leaves the machine: the report is self-contained, anything else is refused.
    await context.route('**/*', (route) => (route.request().url().startsWith('data:') || route.request().url() === 'about:blank' ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.emulateMedia({ media: 'print' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '16mm', left: '11mm', right: '11mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;padding:0 11mm;font:9px 'Segoe UI',Arial,sans-serif;color:#5d6879;display:flex;justify-content:space-between"><span>${esc(title)} · website report</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      timeout: 60000,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * @param {string} html  the report (renderReportHtml)
 * @param {{ title?: string }} [o]
 * @returns {Promise<Buffer>}
 */
export function renderReportPdf(html, { title = 'Site' } = {}) {
  const run = queue.then(() => build(html, title));
  queue = run.catch(() => {}); // a failed PDF must not block the next one
  return run;
}
