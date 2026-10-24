// A file the original serves in pieces: a runtime that keeps a binary index reads it with `?range=from-to[,from-to]`
// (both ends included), expects status 200 and exactly those bytes, and throws on any other answer. A static host knows
// nothing of that query: it answers the bare path with the whole file, or 404 when the copy never held it (parchaa's copy:
// one 404 in the console on every first visit, and best practices 100 → 96). So the copy keeps the WHOLE file once and
// slices it itself: an inline script wraps `fetch` for a first visit (any host, the preview included), and the service
// worker does the same for later visits and for requests the script cannot see (a worker's). Nothing here names a site
// or a framework: the rule is the query's shape, and the whole file is kept only when it really holds the recorded slice
// at those offsets (on another site `?range=` may mean anything).

/** The longest file kept whole (a binary index of a few MB is the usual size). */
export const RANGED_MAX_BYTES = 64 * 1024 * 1024;

const RANGE_QUERY = /^\d+-\d+(,\d+-\d+)*$/;

/**
 * The byte ranges a `?range=` query names, or null when the address has none (or an unusable one).
 * @param {string} url
 * @returns {{ from: number, to: number }[] | null}
 */
export function rangesOf(url) {
  let q;
  try {
    q = new URL(url).searchParams.get('range');
  } catch {
    return null;
  }
  if (!q || !RANGE_QUERY.test(q)) return null;
  const out = [];
  for (const part of q.split(',')) {
    const [from, to] = part.split('-').map(Number);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to - from >= RANGED_MAX_BYTES) return null;
    out.push({ from, to });
  }
  return out;
}

/**
 * The bytes those ranges name in a whole file, one after the other (the answer a slicing host gives), or null when the
 * file does not reach that far.
 * @param {Buffer|Uint8Array} whole
 * @param {{ from: number, to: number }[]} ranges
 */
export function sliceOf(whole, ranges) {
  const parts = [];
  for (const { from, to } of ranges) {
    if (to >= whole.length) return null;
    parts.push(whole.subarray(from, to + 1));
  }
  return Buffer.concat(parts);
}

/** The pathname of an address without its query, decoded; null when it is no address. */
export function barePathOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
}

/**
 * The inline script that answers a ranged request of a kept file from the copy itself, on a first visit (no worker yet).
 * It wraps whatever `fetch` is at the time: in the preview that is the preview's own wrapper, which moves the whole file's
 * address under the preview's path. The whole file is fetched once per page and sliced for every request; when anything
 * goes wrong the request goes to the server as it would have.
 * @param {Record<string, { file: string, type?: string|null }>} ranged  original pathname → the whole file's local path + type
 */
export function rangeShim(ranged) {
  return "(function(){window.sasRanged=true;var R=" + JSON.stringify(ranged) + ";var F=window.fetch;var C={};"
    + "function P(q){if(!/^\\d+-\\d+(,\\d+-\\d+)*$/.test(q))return null;var o=[],p=q.split(','),i,e;for(i=0;i<p.length;i++){e=p[i].split('-');if(!(+e[1]>=+e[0]))return null;o.push([+e[0],+e[1]])}return o}"
    + "function K(n){for(var p in R){if(n===p||n.slice(-p.length)===p)return p}return null}"
    + "function W(k){return C[k]||(C[k]=F.call(window,R[k].file).then(function(r){if(!r.ok)throw Error(r.status);return r.arrayBuffer()}))}"
    + "window.fetch=function(i,o){try{var s=typeof i==='string'?i:(i instanceof URL?i.href:i&&i.url);var u=new URL(s,location.href);var k=u.origin===location.origin?K(u.pathname):null;var g=k&&P(u.searchParams.get('range')||'');"
    + "if(g){return W(k).then(function(b){var n=0,j,at=0;for(j=0;j<g.length;j++){if(g[j][1]>=b.byteLength)throw Error('past the end');n+=g[j][1]-g[j][0]+1}var out=new Uint8Array(n);for(j=0;j<g.length;j++){out.set(new Uint8Array(b,g[j][0],g[j][1]-g[j][0]+1),at);at+=g[j][1]-g[j][0]+1}"
    + "return new Response(out,{status:200,headers:{'content-type':R[k].type||'application/octet-stream'}})}).catch(function(){return F.call(window,i,o)})}}catch(e){}return F.call(window,i,o)};})();";
}

/** The same slicing inside the service worker (a function declaration the worker source includes). */
export const SW_RANGED_SOURCE = `
function rangesOf(q) {
  if (!/^\\d+-\\d+(,\\d+-\\d+)*$/.test(q)) return null;
  const out = [];
  for (const part of q.split(',')) { const [a, b] = part.split('-').map(Number); if (!(b >= a)) return null; out.push([a, b]); }
  return out;
}
function rangedKey(pathname) { return Object.keys(RANGED).find((p) => pathname === p || pathname.endsWith(p)) ?? null; }
async function rangedAnswer(key, ranges) {
  const r = await fetch(new URL(RANGED[key].file, self.location.origin));
  if (!r.ok) throw new Error(String(r.status));
  const b = await r.arrayBuffer();
  let n = 0;
  for (const [a, z] of ranges) { if (z >= b.byteLength) throw new Error('past the end'); n += z - a + 1; }
  const out = new Uint8Array(n);
  let at = 0;
  for (const [a, z] of ranges) { out.set(new Uint8Array(b, a, z - a + 1), at); at += z - a + 1; }
  return new Response(out, { status: 200, headers: { 'content-type': RANGED[key].type || 'application/octet-stream' } });
}
`;
