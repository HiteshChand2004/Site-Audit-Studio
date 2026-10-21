// DEPLOY.md and KNOWN-ISSUES.md inside a download ("Copy my site", docs/COPY-MY-SITE.md §8). The open items come from the
// copy's report (report.copy.openItems, written by the copy pipeline).
import { deployMd, knownIssuesMd } from '../../copy/deploy.js';
import { REASONS } from '../../copy/openItems.js';

/**
 * @param {object} o
 * @param {object} o.report
 * @param {string} o.stack
 * @param {string} o.root   the folder name inside the zip
 * @returns {{ name: string, content: string }[]}
 */
export function notesEntries({ report, stack, root }) {
  // An as-is copy names the address its fixes actually used (copy/address.js: none unless usable and confirmed); report.baseUrl
  // is the original's own origin when no address was set, which DEPLOY.md must never call the new site's.
  const address = report.asIs ? (report.asIs.address?.used ?? null) : (report.baseUrl ?? null);
  const siteName = siteNameOf(report);
  const copy = report.copy ?? {};
  const entries = [{ name: `${root}/DEPLOY.md`, content: deployMd({ stack, siteName, address, formEndpoint: copy.formEndpoint ?? null, checks: copy.deployChecks ?? [] }) }];
  const pages = (copy.openItems ?? []).map((o) => ({
    page: o.page ?? '-',
    check: o.check,
    values: o.values,
    tried: o.tried,
    reason: `${REASONS[o.reason]?.code ?? o.reason} — ${REASONS[o.reason]?.text ?? ''}`.trim(),
  }));
  const known = knownIssuesMd({ siteName, stack, pages });
  if (known) entries.push({ name: `${root}/KNOWN-ISSUES.md`, content: known });
  return entries;
}

function siteNameOf(report) {
  if (report.siteName) return report.siteName;
  try { return new URL(report.baseUrl ?? report.url ?? '').hostname.replace(/^www\./, ''); } catch { return 'Your site'; }
}
