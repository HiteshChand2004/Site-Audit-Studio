// Runs one Lighthouse pass in a child process (forked by run.js), so a crash or hang cannot
// take the API server down. Writes the full LHR to disk and sends a trimmed summary back.
import { writeFile } from 'node:fs/promises';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import * as chromeLauncher from 'chrome-launcher';
import { proxyChromeFlags } from '../../security/egressProxy.js';

const CATEGORIES = ['performance', 'seo', 'accessibility', 'best-practices'];

function summarize(lhr) {
  const audits = {};
  for (const [id, a] of Object.entries(lhr.audits)) {
    audits[id] = {
      title: a.title,
      score: a.score,
      numericValue: a.numericValue,
      displayValue: a.displayValue,
      savingsMs: a.details?.overallSavingsMs ?? a.metricSavings?.LCP ?? null,
      savingsBytes: a.details?.overallSavingsBytes ?? null,
      itemCount: Array.isArray(a.details?.items) ? a.details.items.length : null,
      summary: a.details?.summary ?? null,
    };
  }
  return {
    finalUrl: lhr.finalDisplayedUrl,
    runtimeError: lhr.runtimeError?.message ?? null,
    runWarnings: lhr.runWarnings,
    categories: Object.fromEntries(Object.entries(lhr.categories).map(([id, c]) => [id, c.score])),
    metrics: lhr.audits.metrics?.details?.items?.[0] ?? null,
    audits,
  };
}

process.once('message', async ({ url, formFactor, chromePath, outFile, proxy }) => {
  let chrome;
  try {
    chrome = await chromeLauncher.launch({
      chromePath,
      chromeFlags: ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', ...(proxy ? proxyChromeFlags(proxy) : [])],
      logLevel: 'silent',
    });
    process.send({ type: 'chrome', pid: chrome.pid });
    const flags = { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: CATEGORIES, maxWaitForLoad: 45000 };
    const result = await lighthouse(url, flags, formFactor === 'desktop' ? desktopConfig : undefined);
    if (!result?.lhr) throw new Error('Lighthouse returned no result');
    if (outFile) await writeFile(outFile, JSON.stringify(result.lhr));
    process.send({ type: 'done', summary: summarize(result.lhr) });
  } catch (err) {
    process.send({ type: 'error', message: err.message });
  } finally {
    // On Windows, deleting Chrome's temp profile often fails with EPERM. That is harmless.
    try {
      await chrome?.kill();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
});
