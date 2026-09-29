// Attribute guard for the HTML elements of the IR. The capture keeps the original attributes of
// every element (minus class/style/id/URLs, which the IR rebuilds), so event handlers and other
// script entry points of the original page have to be removed here:
// - on* event handlers, srcdoc, formaction and legacy script hooks;
// - any value that is a javascript:/vbscript: URL or an HTML/script data: URL;
// - elements that load active content (object, applet, frame, frameset, base) are dropped.
const DROP_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'ping', 'background', 'dynsrc', 'lowsrc', 'codebase', 'classid', 'data', 'xmlns', 'is']);
const SCRIPT_VALUE = /^(java|vb|live)script:|^data:(text\/html|application\/(x?html|javascript|ecmascript)|text\/(x?javascript|ecmascript))/i;
export const DROP_TAGS = new Set(['object', 'applet', 'frame', 'frameset', 'base', 'script', 'noscript', 'template', 'meta', 'link', 'style']);

const compact = (v) => String(v).replace(/[\u0000- \u007f-\u009f]+/g, '');

/**
 * Removes unsafe attributes in place.
 * @returns {{ handlers: number, scriptUrls: number, other: number }}
 */
export function guardAttributes(attrs, stats = { handlers: 0, scriptUrls: 0, other: 0 }) {
  for (const [name, value] of Object.entries(attrs)) {
    const lname = name.toLowerCase();
    if (/^on/.test(lname)) {
      delete attrs[name];
      stats.handlers++;
    } else if (typeof value === 'string' && SCRIPT_VALUE.test(compact(value))) {
      delete attrs[name];
      stats.scriptUrls++;
    } else if (DROP_ATTRS.has(lname) || !/^[a-z_][\w:.-]*$/i.test(name)) {
      delete attrs[name];
      stats.other++;
    }
  }
  return stats;
}
