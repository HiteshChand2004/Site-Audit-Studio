// The report as a PDF, made by the Chromium the rest of the app already uses: the HTML report is loaded from memory
// (no network: every image is inline, the page has no script) and printed to A4. The report lays out its own A4
// sheets (full-bleed header band, page numbers in its own footer), so the print has no margins and no browser
// header or footer. One PDF at a time, so several clicks do not start several browsers.
import { launchBrowser } from '../audit/render.js';

let queue = Promise.resolve();

async function build(html) {
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
      preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
      timeout: 60000,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * @param {string} html  the report (renderReportHtml)
 * @param {{ title?: string }} [_o]  kept for callers; the report prints its own footer
 * @returns {Promise<Buffer>}
 */
export function renderReportPdf(html, _o = {}) {
  const run = queue.then(() => build(html));
  queue = run.catch(() => {}); // a failed PDF must not block the next one
  return run;
}
