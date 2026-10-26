// DEPLOY.md and KNOWN-ISSUES.md inside a download ("Copy my site", docs/COPY-MY-SITE.md §8). The open items come from the
// copy's report (report.copy.openItems, written by the copy pipeline).
import { deployMd, describePackage, knownIssuesMd } from '../../copy/deploy.js';
import { REASONS } from '../../copy/openItems.js';
import { reasonText } from '../../copy/gotWorse.js';

/**
 * @param {object} o
 * @param {object} o.report
 * @param {string} o.stack
 * @param {string} o.root   the folder name inside the zip
 * @param {{ files: string[], read: (rel: string) => string | null }} o.shipped  what the zip holds under root (its files, and
 *   the text of one): DEPLOY.md is written from that package's own scripts and folders (copy/deploy.js describePackage)
 * @returns {{ name: string, content: string }[]}
 */
export function notesEntries({ report, stack, root, shipped }) {
  // An as-is copy names the address its fixes actually used (copy/address.js: none unless usable and confirmed); report.baseUrl
  // is the original's own origin when no address was set, which DEPLOY.md must never call the new site's.
  const address = report.asIs ? (report.asIs.address?.used ?? null) : (report.baseUrl ?? null);
  const siteName = siteNameOf(report);
  const copy = report.copy ?? {};
  const entries = [{ name: `${root}/DEPLOY.md`, content: deployMd({ stack, shipped: describePackage(shipped), siteName, address, formEndpoint: copy.formEndpoint ?? null, formsSaved: report.asIs?.convert?.wiredForms ?? 0, forms: report.asIs?.formRoutes ?? null, checks: copy.deployChecks ?? [] }) }];
  const pages = (copy.openItems ?? []).map((o) => ({
    page: o.page ?? '-',
    check: o.check,
    values: o.values,
    tried: o.tried,
    reason: `${REASONS[o.reason]?.code ?? o.reason} — ${REASONS[o.reason]?.text ?? ''}`.trim(),
  }));
  // "Got worse" and "still open" rows of the re-audit (an as-is copy), each with its reason, or said to be unexplained: none is left out.
  for (const [label, rows] of [['Got worse', copy.worse ?? []], ['Still open', copy.stillOpen ?? []]]) {
    for (const w of rows) {
      pages.push({
        page: `${label}: ${w.title}`,
        check: label === 'Got worse' ? 'the copy against the original, every copied page (the check after the copy)' : 'failing on the original and still failing in the copy (the check after the copy)',
        values: `${w.before?.detail ?? w.before?.status ?? '-'} → ${w.after?.detail ?? w.after?.status ?? '-'}`,
        meaning: w.reasonEvidence ?? null,
        tried: w.reason ? 'nothing in the copy: this is left to you, for the reason below' : 'no automatic fix yet',
        reason: reasonText(w.reason ?? null),
      });
    }
  }
  // A copy converted into the stack's code: every part kept as the original HTML, in plain words, with where and why.
  for (const f of report.asIs?.convert?.fallbacks ?? []) {
    pages.push({
      page: f.page,
      check: `kept as the original HTML: <${f.tag}>${f.attribute ? ` (attribute ${f.attribute})` : ''} at ${f.where}`,
      values: f.reason,
      tried: 'converted into a component like the rest of the page; this element is kept inside it as the original HTML, so the page is unchanged',
      reason: `${REASONS.converted.code} — ${REASONS.converted.text}`,
    });
  }
  const known = knownIssuesMd({ siteName, stack, pages });
  if (known) entries.push({ name: `${root}/KNOWN-ISSUES.md`, content: known });
  return entries;
}

function siteNameOf(report) {
  if (report.siteName) return report.siteName;
  try { return new URL(report.baseUrl ?? report.url ?? '').hostname.replace(/^www\./, ''); } catch { return 'Your site'; }
}
