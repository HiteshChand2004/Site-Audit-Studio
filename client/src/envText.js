// A pasted or imported .env, split into names and values in the browser, so its lines land in the settings rows before anything
// is saved. The same rules as the server's parseEnvText (server/src/apps/detect.js), which checks every name again on save.

/** A setting name the server takes. */
export const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * `NAME=value` lines (an `export` in front, quotes, a quoted value over several lines, `# comments`) → [name, value] in order.
 * @param {string} text @returns {[string, string][]}
 */
export function parseEnvText(text) {
  const out = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if (q === '"' || q === "'") {
      // A quoted value may run over several lines (a private key).
      let rest = value.slice(1);
      while (!rest.includes(q) && i + 1 < lines.length) rest += `\n${lines[(i += 1)]}`;
      value = rest.slice(0, rest.lastIndexOf(q));
      if (q === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out.set(m[1], value);
  }
  return [...out];
}
