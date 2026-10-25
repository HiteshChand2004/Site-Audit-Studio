// Which form of the site a submission comes from. The pages are the original's, unchanged: a form carries no id of this
// server. In the browser the copy's form guard sends every form's fields to /api/forms (the endpoint in sas-forms.json);
// without script a form posts its fields to its own action, as on the original. What identifies it is the page it was sent
// from (the Referer the browser adds) or the address it posted to, and the names of its fields. Pure functions, no I/O.

/** The page files an address of the site can mean: / → index.html, /about/ → about/index.html, /about → about.html or about/index.html. */
export function pageFilesOf(pathname) {
  let p = String(pathname ?? '/');
  try { p = decodeURIComponent(p); } catch { /* keep it as sent */ }
  const rel = p.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) return [`${rel}index.html`];
  if (/\.html?$/i.test(rel)) return [rel];
  return [`${rel}.html`, `${rel}/index.html`];
}

/** The path of the page a request came from (its Referer on this site), or null. */
export function refererPath(referer, host) {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return u.host === host ? u.pathname : null;
  } catch {
    return null;
  }
}

/**
 * The form a submission belongs to.
 * @param {object[]} forms  forms.json: { id, file, action, names, wired }
 * @param {object} o
 * @param {string[]} o.names        the names of the submitted fields
 * @param {string|null} [o.from]    the path of the page it was sent from (Referer), when known
 * @param {string|null} [o.action]  the path it was posted to, when it was not this server's own endpoint (a form without script)
 * @returns {object|null}
 */
export function matchForm(forms, { names, from = null, action = null }) {
  let candidates = forms;
  if (action) candidates = candidates.filter((f) => f.action === action);
  if (from) {
    const files = new Set(pageFilesOf(from));
    const onPage = candidates.filter((f) => files.has(f.file));
    // A page the forms do not know (an address written another way) leaves the choice to the fields.
    if (onPage.length) candidates = onPage;
  }
  if (!candidates.length) return null;
  const sent = new Set(names);
  let best = null;
  let bestScore = -1;
  for (const f of candidates) {
    const own = new Set(f.names);
    const shared = [...sent].filter((n) => own.has(n)).length;
    const score = shared / (new Set([...sent, ...own]).size || 1);
    // A tie goes to a form this server stores (it is the one a person would want the data from).
    if (score > bestScore || (score === bestScore && f.wired && !best.wired)) { best = f; bestScore = score; }
  }
  // One candidate is the form whatever its fields; among several, the fields must say which.
  if (candidates.length > 1 && bestScore <= 0) return null;
  return best;
}
