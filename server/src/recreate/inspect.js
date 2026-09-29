// Recreate step 1, "Inspecting pages": page discovery, then a Playwright capture of every selected
// page at 1440 / 768 / 375. Chromium runs behind the SSRF egress proxy, like Analyze.
// Writes capture/manifest.json and sets ctx.pages / ctx.discovery for the later steps.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../audit/render.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { capturePage } from './capture/index.js';
import { discoverPages, SKIP_LABELS } from './discover.js';
import { RecreateError } from './errors.js';

const once = (fn) => {
  let done = null;
  return () => (done ??= fn());
};

/** @param {object} ctx  the pipeline context (recreate/index.js) */
export async function inspectStage(ctx) {
  const { report } = ctx;
  ctx.progress(0, 'Finding pages');
  const discovery = await discoverPages({
    url: ctx.audit.url ?? ctx.project.url,
    limit: ctx.pageLimit,
    signal: ctx.signal,
    onProgress: (f, message) => ctx.progress(0.2 * f, message),
  });

  const proxy = await startEgressProxy(ctx.netPolicy);
  const closeProxy = once(() => proxy.close());
  ctx.defer(closeProxy);
  let browser;
  const closeBrowser = once(() => browser?.close().catch(() => {}));
  ctx.defer(closeBrowser);

  const pages = [];
  const failedPages = [];
  try {
    browser = await launchBrowser({ proxy: proxy.url });
    const total = discovery.pages.length;
    for (const [i, info] of discovery.pages.entries()) {
      if (ctx.signal.aborted) throw new RecreateError('Recreate was stopped.');
      ctx.progress(0.2 + 0.8 * (i / total), `Capturing ${info.path} (${i + 1} of ${total})`);
      const { views, errors } = await capturePage(browser, info, ctx.dir);
      for (const e of errors) report.errors.push({ step: 'inspect', message: `${info.path} (${e.view}): ${e.message}` });
      if (!views.desktop) {
        // The desktop capture is the base layout; without it the page cannot be rebuilt.
        if (i === 0) throw new RecreateError(`The homepage could not be captured: ${errors[0]?.message ?? 'unknown error'}`);
        failedPages.push({ url: info.url, source: info.source, reason: 'capture-failed' });
        continue;
      }
      pages.push({ ...info, views });
    }
  } finally {
    await closeBrowser();
    await closeProxy();
  }

  ctx.discovery = discovery;
  ctx.pages = pages;
  // Links to these pages keep pointing at the live site (Phase 4a decision).
  ctx.livePages = [...discovery.beyondLimit, ...failedPages];

  report.pages = pages.map((p) => ({
    url: p.url,
    path: p.path,
    outPath: p.outPath,
    title: p.title,
    source: p.source,
    views: Object.keys(p.views),
    // Scroll-reveal elements captured in their revealed state, per view (capture/index.js).
    revealPinned: Object.fromEntries(Object.entries(p.views).map(([v, x]) => [v, x.reveal?.pinned ?? 0])),
  }));
  const revealPages = report.pages.filter((p) => Object.values(p.revealPinned).some((n) => n > 0));
  if (revealPages.length) {
    report.warnings.push(`Scroll-reveal content on ${revealPages.length} ${revealPages.length === 1 ? 'page' : 'pages'} was captured in its revealed state (${revealPages.map((p) => p.path).slice(0, 5).join(', ')}); the reveal animation itself comes in Phase 4b.`);
  }
  report.discovery = {
    pageLimit: ctx.pageLimit,
    crawled: discovery.crawled,
    sitemap: discovery.sitemap,
    skipped: discovery.skipped.map((s) => ({ ...s, detail: SKIP_LABELS[s.reason] })),
    linksToLive: ctx.livePages.map((p) => ({ url: p.url, reason: p.reason ?? 'beyond-limit' })),
  };
  report.blockedHosts = proxy.blocked();
  for (const s of discovery.skipped.filter((s) => s.reason === 'backend')) {
    report.manual.push({ kind: 'page', title: `${new URL(s.url).pathname} was not recreated`, detail: SKIP_LABELS.backend, url: s.url });
  }

  await writeFile(
    path.join(ctx.dir, 'capture', 'manifest.json'),
    JSON.stringify({ homeUrl: discovery.homeUrl, origin: discovery.origin, pages, discovery: report.discovery }, null, 1),
  );
  ctx.progress(1, `Captured ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`);
}
