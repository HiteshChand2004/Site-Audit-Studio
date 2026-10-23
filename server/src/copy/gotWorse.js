// "Got worse" on an as-is copy (docs/COPY-MY-SITE.md §5): every item the re-audit marks regressed is either explained by one
// of the five reasons, on evidence the run measured, or it is UNEXPLAINED and said to be so. Nothing is dropped and no reason
// is given by default: an item none of the rules below can back stays unexplained (a fix that is still owed).
//
// The evidence each reason needs:
//   c (owner)        a link or a request goes to a page of the site this copy does not hold (the pages copied were chosen),
//                    and that page works on the original; or a link to another site that is dead (the owner decides);
//   a (third_party)  the request that fails is to a host that is neither the copy nor the original;
//   e (deploy)       a Lighthouse check whose measured amount (bytes, elements, the page's weight) did not grow in the copy:
//                    only its score moved, with the simulated load time of a local preview over HTTP/1.1, which only the
//                    real host settles (the original was measured on its own host);
//   d (look)         colour contrast: every element failing only in the copy has the same colours and ratio as one failing on
//                    the original (the count moves with what a marquee or a carousel shows when the check runs); the colours
//                    are the original's, and changing them is a change of its look (§2: contrast is never rewritten as-is);
//   b                not decided here: a backend item or a reverted fix carries its reason from the copy run (openItems.js).
import { REASONS } from './openItems.js';

/** How much a measured amount may move before it counts as grown: bytes and times vary run to run, element counts do not. */
const GROWTH = { element: 0.02, other: 0.1 };

const normPath = (p) => (p.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '') || '/');
const pathOf = (url) => {
  try {
    return normPath(decodeURIComponent(new URL(url).pathname));
  } catch {
    return null;
  }
};
const bareHost = (h) => String(h ?? '').replace(/^www\./, '').toLowerCase();
const hostOf = (url) => {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return '';
  }
};
const hasFileExt = (p) => /\.[a-z0-9]{1,6}$/i.test(p);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/**
 * @param {object} o
 * @param {object[]} o.items            checklist items (only status 'regressed' are looked at)
 * @param {string} o.siteUrl            the original's address
 * @param {string} o.copyOrigin         where the copy was served for the re-audit
 * @param {string[]} o.copyPages        the copy's page paths ("/", "/about/")
 * @param {string[]} [o.chosenPages]     the pages asked for (their paths); one asked for and missing is never "not chosen"
 * @param {{ mobile?: object, desktop?: object }} o.oldLhr  the original's Lighthouse reports
 * @param {{ mobile?: object, desktop?: object }} o.newLhr  the copy's
 * @param {object} [o.oldAxe]           the original's axe results (homepage)
 * @param {object} [o.newAxe]           the copy's
 * @returns {{ items: object[], summary: { total: number, explained: number, unexplained: number, byReason: Record<string, number> } }}
 */
export function explainWorse({ items, siteUrl, copyOrigin, copyPages, chosenPages = copyPages, oldLhr = {}, newLhr = {}, oldAxe = null, newAxe = null }) {
  const site = bareHost(new URL(siteUrl).hostname);
  const copyHost = hostOf(copyOrigin);
  const copied = new Set(copyPages.map(normPath));
  const chosen = new Set(chosenPages.map(normPath));
  const ctx = { site, copyHost, copied, chosen, oldLhr, newLhr, oldAxe, newAxe };
  const out = items.filter((i) => i.status === 'regressed').map((item) => ({ key: item.key, title: item.title, before: item.before, after: item.after, ...explainOne(item, ctx) }));
  const summary = { total: out.length, explained: 0, unexplained: 0, byReason: {} };
  for (const i of out) {
    if (i.reason) {
      summary.explained++;
      summary.byReason[i.reason] = (summary.byReason[i.reason] ?? 0) + 1;
    } else summary.unexplained++;
  }
  return { items: out, summary };
}

/** One item: { reason, evidence } or { reason: null, evidence, unexplained: true }. */
function explainOne(item, ctx) {
  const key = item.key ?? '';
  if (key === 'links.broken-new') return plainNotCopied(byParts(item.links?.new ?? [], (l) => linkPart(l, ctx), 'link'), ctx, 'links');
  if (key === 'lighthouse.errors-in-console') return plainNotCopied(byParts(consoleErrors(ctx.newLhr), (e) => requestPart(e, ctx), 'console error'), ctx, 'prefetch');
  if (key.startsWith('lighthouse.')) return lighthousePart(item, key.slice('lighthouse.'.length), ctx);
  if (key === 'axe.color-contrast') return contrastPart(ctx);
  return unexplained('No rule of the five reasons applies to this check on the evidence of this run.');
}

const unexplained = (evidence) => ({ reason: null, unexplained: true, evidence });

/**
 * An item made of parts (links, console errors): explained only when every part is; one reason per item when the parts agree,
 * else each part keeps its own (listed) and the item names them all. A part with no reason leaves the whole item unexplained.
 */
function byParts(list, explain, noun) {
  if (!list.length) return unexplained(`The re-audit listed no ${noun}s for this item, so nothing could be checked.`);
  const parts = list.map(explain);
  const missing = parts.filter((p) => !p.reason);
  const reasons = [...new Set(parts.map((p) => p.reason).filter(Boolean))];
  if (missing.length) {
    return { reason: null, unexplained: true, parts, evidence: `${missing.length} of ${parts.length} ${noun}s have no reason: ${missing.slice(0, 3).map((p) => `${p.what} (${p.evidence})`).join('; ')}.` };
  }
  return {
    reason: reasons.length === 1 ? reasons[0] : reasons.join('+'),
    parts,
    evidence: reasons.map((r) => `${parts.filter((p) => p.reason === r).length} ${noun}(s): ${parts.find((p) => p.reason === r).evidence}`).join(' '),
  };
}

function linkPart(link, ctx) {
  const what = link.url;
  if (hostOf(link.url) !== ctx.site) {
    return { what, reason: 'owner', evidence: 'links to another site that is dead now; whether to keep, change or remove it is the owner\'s decision' };
  }
  const p = pathOf(link.url);
  if (p && ctx.copied.has(p)) return { what, reason: null, evidence: `the copy holds ${p}, yet the link fails (HTTP ${link.status})` };
  if (p && hasFileExt(p)) return { what, reason: null, evidence: `a file of the site (${p}) the copy does not hold` };
  if (p && ctx.chosen.has(p)) return { what, reason: null, evidence: `${p} was asked for but is not in the copy` };
  // Pages the original's own link check reached (this row is new: the original had no such broken link) and the copy left out.
  return { what, reason: 'owner', notCopied: p, evidence: 'go to pages that were not copied; they work on the original' };
}

const listOf = (paths) => (paths.length > 6 ? `${paths.slice(0, 6).join(', ')} and ${paths.length - 6} more` : paths.join(', '));

/**
 * The words a user reads for pages left out of the copy (reason c): which pages, that they are not in the copy, what a visitor
 * gets there (a 404), and what to do. The row's other parts (another reason, or none) follow as they were.
 */
function plainNotCopied(r, ctx, kind) {
  const left = [...new Set((r.parts ?? []).map((p) => p.notCopied).filter(Boolean))].sort();
  if (!left.length) return r;
  const held = [...ctx.copied].sort();
  const pages = (n) => (n === 1 ? '1 page' : `${n} pages`);
  const what = kind === 'links'
    ? `These pages of your site were not copied: ${listOf(left)}. The copy holds ${pages(held.length)} (${listOf(held)}). The links to them are still in the copy, and there they lead to a "page not found" error (404); on the original they work.`
    : `The page loads these pages in the background, ahead of a click: ${listOf(left)}. They were not copied, so in the copy each of these requests fails with a 404 and shows as an error in the browser's console. Visitors do not see the error, but a click on a link to one of these pages leads to "page not found".`;
  const fix = 'To fix it: make the copy again with these pages included, or change or remove the links to them in the copy before you publish it.';
  const others = (r.parts ?? []).filter((p) => !p.notCopied);
  const rest = others.length ? ` Also: ${others.slice(0, 3).map((p) => `${p.what} — ${p.reason ? '' : 'no reason: '}${p.evidence}`).join('; ')}.` : '';
  // A row still unexplained leads with what has no reason; the pages left out follow in the same plain words.
  return { ...r, evidence: r.unexplained ? `${r.evidence} ${what} ${fix}` : `${what} ${fix}${rest}` };
}

/** The failed requests Lighthouse logged on the copy (mobile and desktop, each address once). */
function consoleErrors(lhr) {
  const seen = new Map();
  for (const device of ['mobile', 'desktop']) {
    for (const i of lhr[device]?.audits?.['errors-in-console']?.details?.items ?? []) {
      const url = i.sourceLocation?.url ?? i.url ?? '';
      const k = url || i.description;
      if (!seen.has(k)) seen.set(k, { url, text: String(i.description ?? '').slice(0, 160), source: i.source });
    }
  }
  return [...seen.values()];
}

function requestPart(e, ctx) {
  const what = e.url || e.text;
  if (!e.url) return { what, reason: null, evidence: `an error of the page itself: ${e.text}` };
  const host = hostOf(e.url);
  if (host !== ctx.copyHost && host !== ctx.site) return { what, reason: 'third_party', evidence: `requests to ${host}, which is neither the copy nor the original` };
  const p = pathOf(e.url);
  if (p && !hasFileExt(p) && !ctx.copied.has(p) && !ctx.chosen.has(p)) {
    return { what, reason: 'owner', notCopied: p, evidence: 'the page loading a page that was not copied, ahead of a click' };
  }
  return { what, reason: null, evidence: hasFileExt(p ?? '') ? `the copy does not hold the file ${p}` : `${e.text}` };
}

/** A Lighthouse row: explained (deploy) only when what it measures did not grow on any device, page weight included. */
function lighthousePart(item, id, ctx) {
  const rows = [];
  let grew = false;
  let measured = 0;
  for (const device of ['mobile', 'desktop']) {
    const b = amountOf(ctx.oldLhr[device]?.audits?.[id]);
    const a = amountOf(ctx.newLhr[device]?.audits?.[id]);
    if (!a) continue;
    measured++;
    const limit = (b?.value ?? 0) * (1 + (a.unit === 'element' ? GROWTH.element : GROWTH.other));
    const timeOnly = a.unit === 'ms';
    if (timeOnly) {
      // A time has no amount of its own: the page's weight decides whether the copy sends more for it to load.
      const wb = amountOf(ctx.oldLhr[device]?.audits?.['total-byte-weight']);
      const wa = amountOf(ctx.newLhr[device]?.audits?.['total-byte-weight']);
      if (!wb || !wa) return unexplained(`${device}: the page's weight is not in both reports, so the time ${Math.round(a.value)} ms cannot be put down to the host.`);
      // The same page loading more slowly is the host; a different largest element is a different page (a picture or a
      // video the copy lacks lets another element become the largest), which no host explains.
      const lb = lcpElement(ctx.oldLhr[device]);
      const la = lcpElement(ctx.newLhr[device]);
      if (lb && la && lb.selector !== la.selector && lb.path !== la.path) {
        return unexplained(`${device}: the largest element is not the same one: the original's is ${lb.snippet}, the copy's is ${la.snippet}.`);
      }
      if (wa.value > wb.value * (1 + GROWTH.other)) {
        grew = true;
        rows.push(`${device}: ${Math.round(a.value)} ms, and the copy's page weighs ${kb(wa.value)} against the original's ${kb(wb.value)}`);
      } else rows.push(`${device}: ${b ? `${Math.round(b.value)} → ` : ''}${Math.round(a.value)} ms, the page not heavier (${kb(wb.value)} → ${kb(wa.value)}) and the same largest element`);
      continue;
    }
    if (a.value > 0 && a.value > limit) {
      grew = true;
      rows.push(`${device}: ${fmt(b)} → ${fmt(a)}`);
    } else rows.push(`${device}: ${fmt(b)} → ${fmt(a)}`);
  }
  if (!measured) return unexplained('The copy\'s Lighthouse report has no measured amount for this check.');
  if (grew) return unexplained(`What the check measures grew in the copy (${rows.join('; ')}).`);
  return {
    reason: 'deploy',
    evidence: `What the check measures did not grow in the copy (${rows.join('; ')}); only its score moved, with the simulated load time of a local preview (HTTP/1.1 on this computer) where the original was measured on its own host. Measure it again after deploying.`,
  };
}

const contrastNodes = (axe) => ((axe?.violations ?? axe?.results?.violations ?? []).find((v) => v.id === 'color-contrast')?.nodes ?? [])
  .map((n) => ({ target: (n.target ?? []).join(' '), colours: colourKey(n.any?.[0]?.data), html: String(n.html ?? '').slice(0, 80) }));
const colourKey = (d) => (d?.fgColor && d?.bgColor ? `${d.fgColor} on ${d.bgColor} (${d.contrastRatio}:1)` : null);

/** Contrast: the same colours as the original's own failures, or not. */
function contrastPart(ctx) {
  const before = contrastNodes(ctx.oldAxe);
  const after = contrastNodes(ctx.newAxe);
  if (!after.length || !ctx.oldAxe) return unexplained('The axe results of both sides are needed to compare the colours, and one is missing.');
  const known = new Set(before.map((n) => n.colours).filter(Boolean));
  const seen = new Set(before.map((n) => n.target));
  const extra = after.filter((n) => !seen.has(n.target));
  const strange = extra.filter((n) => !n.colours || !known.has(n.colours));
  if (strange.length) return unexplained(`${strange.length} element(s) fail with colours the original does not fail with: ${strange.slice(0, 3).map((n) => `${n.html} — ${n.colours ?? 'colours not read'}`).join('; ')}.`);
  return {
    reason: 'look',
    evidence: `${after.length} elements fail against the original's ${before.length}; every one failing only in the copy has the same colours as one failing on the original (${[...new Set(extra.map((n) => n.colours))].join(', ') || 'none new'}): the count moves with what is on screen when the check runs. The colours are the original's own; changing them changes its look.`,
  };
}

/** The page's largest element in one Lighthouse report: { selector, path, snippet }, or null when it named none. */
function lcpElement(lhr) {
  const node = lhr?.audits?.['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node;
  if (!node) return null;
  return { selector: node.selector ?? null, path: node.path ?? null, snippet: String(node.snippet ?? node.selector ?? '').slice(0, 100) };
}

/** What a Lighthouse audit measured: its value (elements, bytes, ms) or the bytes / time it says could be saved. */
function amountOf(a) {
  if (!a) return null;
  const bytes = a.details?.overallSavingsBytes;
  if (Number.isFinite(bytes)) return { value: bytes, unit: 'byte' };
  if (Number.isFinite(a.numericValue)) {
    const u = a.numericUnit ?? '';
    return { value: a.numericValue, unit: u === 'millisecond' ? 'ms' : u === 'byte' ? 'byte' : u === 'element' ? 'element' : u || 'other' };
  }
  const saved = Object.values(a.metricSavings ?? {}).filter(Number.isFinite);
  return saved.length ? { value: saved.reduce((x, y) => x + y, 0), unit: 'ms' } : { value: 0, unit: 'ms' };
}

const fmt = (m) => (!m ? 'none' : m.unit === 'byte' ? kb(m.value) : m.unit === 'ms' ? `${Math.round(m.value)} ms` : `${Math.round(m.value)} ${m.unit}${m.value === 1 ? '' : 's'}`);

/** The reason's code and words for a report line ("c — Needs your decision …"); a joined reason lists each. */
export function reasonText(reason) {
  if (!reason) return 'UNEXPLAINED — none of the five reasons fits on the evidence; this is a fix still owed.';
  return reason.split('+').map((r) => `${REASONS[r]?.code ?? r} — ${REASONS[r]?.text ?? ''}`.trim()).join(' / ');
}
