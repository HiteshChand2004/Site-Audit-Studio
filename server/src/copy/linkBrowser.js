// The real-browser checker for "Copy my site" links (docs/COPY-MY-SITE.md §3). It runs through the same egress proxy and
// address rules as the analysis (security/egressProxy.js, netGuard), so a link cannot reach a private address.
// NOT yet run: browser runs wait for the "machine is free" signal.
import { launchBrowser } from '../audit/render.js';
import { startEgressProxy } from '../security/egressProxy.js';
import { userPolicy } from '../security/netGuard.js';

const TIMEOUT_MS = 20000;

/**
 * Opens a checker for a batch of links. Close it when the batch is done.
 * @returns {Promise<{ check: (url: string) => Promise<{ status?: number, error?: string, timeout?: boolean, redirectedTo?: string }>, close: () => Promise<void> }>}
 */
export async function openLinkChecker({ policy = userPolicy() } = {}) {
  const proxy = await startEgressProxy(policy);
  const browser = await launchBrowser({ proxy: proxy.url });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (compatible; Remastly-LinkCheck)' });
  return {
    async check(url) {
      const page = await context.newPage();
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
        const final = page.url();
        return {
          status: response ? response.status() : undefined,
          ...(final && final !== url && { redirectedTo: final }),
        };
      } catch (err) {
        const message = String(err?.message ?? err);
        return /Timeout/i.test(message) ? { timeout: true } : { error: message.split('\n')[0] };
      } finally {
        await page.close().catch(() => {});
      }
    },
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await proxy.close().catch(() => {});
    },
  };
}
