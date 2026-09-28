// Can the original site be shown in an <iframe>? Decided from response headers only.
export function computeFrame(headers = {}) {
  const xfo = (headers['x-frame-options'] || '').trim();
  if (/^(deny|sameorigin)/i.test(xfo)) {
    return { frameable: false, reason: `X-Frame-Options: ${xfo.toUpperCase()}` };
  }
  const csp = headers['content-security-policy'] || '';
  const directive = csp.split(';').map((d) => d.trim()).find((d) => /^frame-ancestors\b/i.test(d));
  if (directive) {
    const sources = directive.split(/\s+/).slice(1);
    const allowsAny = sources.includes('*') || sources.some((s) => /^(https?:\/\/)?localhost(:\d+)?$/i.test(s));
    if (!allowsAny) return { frameable: false, reason: `CSP ${directive}` };
  }
  return { frameable: true, reason: null };
}
