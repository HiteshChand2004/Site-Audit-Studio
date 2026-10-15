// @ts-check
// Renders the copy as a visitor gets it, page by page and view by view, for the guards that hold it to the capture
// (verify/hittest.js, verify/visibility.js). One local server and one browser serve every guard of a run: each pass
// emits the IR as it stands (an ids build, so every element names the IR node it came from: `data-sas-id`), serves it
// over the written site, and opens each page with its own scripts running and every other origin cut off.
import { emitSite } from '../emit/html.js';
import { startSiteServer } from './server.js';

/**
 * @typedef {{ id: string, width: number, height: number, dpr: number, mobile: boolean }} View
 * @typedef {{ each: (o: { ir: any, pages: any[], views: View[], deadline?: number,
 *   want: (page: any, view: View) => any, visit: (tab: import('playwright').Page, page: any, view: View, wanted: any) => Promise<object> })
 *   => Promise<object[]>, close: () => Promise<void> }} CopyRenderer
 */

/**
 * @param {{ siteDir: string, launchBrowser: () => Promise<any> }} o
 * @returns {Promise<CopyRenderer>}
 */
export async function openCopyRenderer({ siteDir, launchBrowser }) {
  const server = await startSiteServer(siteDir);
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    await server.close().catch(() => {});
    throw err;
  }
  return {
    // `want(page, view)` returns what the capture holds for that page and view (null = nothing to check there);
    // `visit` measures the open tab. Results in order, an error per page and view instead of a thrown one.
    async each({ ir, pages, views, deadline = Infinity, want, visit }) {
      const built = emitSite(ir, { ids: true, inlineCss: true });
      server.overrides.clear();
      for (const [file, text] of built.files) server.overrides.set(file, text);
      const results = [];
      for (const page of pages) {
        for (const view of views) {
          if (Date.now() > deadline) return results;
          const wanted = want(page, view);
          if (!wanted) continue;
          const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: view.dpr, isMobile: view.mobile, hasTouch: view.mobile, serviceWorkers: 'block' });
          try {
            await context.route('**/*', (route) => (route.request().url().startsWith(server.origin) ? route.continue() : route.abort()));
            const tab = await context.newPage();
            await tab.goto(`${server.origin}/${page.outPath}`, { waitUntil: 'load', timeout: 30000 });
            await tab.waitForTimeout(800);
            results.push({ page, view: view.id, ...(await visit(tab, page, view, wanted)) });
          } catch (err) {
            results.push({ page, view: view.id, error: String(err?.message ?? err).split('\n')[0] });
          } finally {
            await context.close().catch(() => {});
          }
        }
      }
      return results;
    },
    async close() {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

/** An IR node by its sid in one page body. */
export function nodeBySid(body, sid) {
  let found = null;
  const walk = (n) => {
    if (found || !n || 'text' in n) return;
    if (String(n.sid) === String(sid)) found = n;
    else (n.children ?? []).forEach(walk);
  };
  walk(body);
  return found;
}

/** The empty `ir.motion` shape the emitters read, for a copy that has no motion of its own, with `extra` set. */
export function withMotion(ir, extra) {
  ir.motion = { hover: [], focus: [], reveal: [], delays: [], loops: [], widgets: [], scrolled: [], states: 0, notices: 0, panels: 0, hoverCards: 0, script: false, ...(ir.motion ?? {}), ...extra };
}
