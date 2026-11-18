// @ts-check
// Go live → "Run my app on Remastly" → "Copy settings from the old server": the settings the app already has on the server the
// website runs on now, read over SSH instead of typed again. Optional: typing or pasting them stays the other way.
//   findSettings   one SSH visit: the settings files and running programs there, as names only (never values), ranked by how
//                  many of the names the app's code reads they hold
//   readSettings   one SSH visit: the chosen file or program's settings (values), which the caller saves sealed
// The login (key or password) is used for that visit only and never kept. The address must be a public one (security/netGuard.js),
// so this cannot be used to reach Remastly's own network. Read-only: the scripts only list and read (`find`, `sed`, `cat`); with a
// login allowed `sudo` without a password they read through `sudo -n` (files of another user, 0600), else what the login can read.
import net from 'node:net';
import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import { resolveChecked, BlockedAddressError } from '../security/netGuard.js';

export const OLD_SERVER_LIMITS = { connectMs: 15_000, runMs: 60_000, outputBytes: 2 * 1024 * 1024, fileBytes: 512 * 1024, sources: 20 };

export class OldServerError extends Error {}

/** Programs that run apps: a running one's settings are what the app really started with (PM2, systemd, Docker alike). */
const RUNTIMES = 'node|nodejs|python|python3|ruby|php|php-fpm|java|bun|deno|gunicorn|uvicorn|puma|next-server';

// One `sudo -n` check, shared by both scripts: S is the prefix every read goes through.
const SUDO = 'S=""; if [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null; then S="sudo -n"; fi; printf "SUDO\\t%s\\n" "${S:+yes}"';

// Lists settings files (.env, .env.production, api.env…; never the .example kind) under the usual app folders and every systemd
// EnvironmentFile, then each running app program; prints names only. node_modules and .git are never walked. A program's
// environment is NUL-separated: NUL and line break are swapped in one step, so a value with line breaks (a key) stays one entry.
const FIND_SCRIPT = `${SUDO}
{
  for d in /home /root /srv /var/www /opt /app /usr/src/app /var/app; do
    [ -d "$d" ] && $S find "$d" -maxdepth 6 \\( -name node_modules -o -name .git -o -name .cache -o -name .npm \\) -prune -o -type f \\( -name .env -o -name '.env.*' -o -name '*.env' \\) -print 2>/dev/null
  done
  $S grep -rhs '^EnvironmentFile=' /etc/systemd/system /lib/systemd/system /usr/lib/systemd/system 2>/dev/null | sed 's/^EnvironmentFile=-\\{0,1\\}//'
} | grep -Ev '[.](example|sample|template|dist|tpl)$|/example[.]env$' | sort -u | head -n 200 | while IFS= read -r f; do
  if $S test -r "$f"; then r=1; else r=0; fi
  n=$($S sed -n 's/^[[:space:]]*\\(export[[:space:]]\\{1,\\}\\)\\{0,1\\}\\([A-Za-z_][A-Za-z0-9_]*\\)[[:space:]]*=.*/\\2/p' "$f" 2>/dev/null | head -n 300 | tr '\\n' ' ')
  printf 'F\\t%s\\t%s\\t%s\\n' "$f" "$r" "$n"
done
for p in /proc/[0-9]*; do
  c=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | cut -c1-200)
  b=$(printf '%s' "$c" | cut -d' ' -f1); b=\${b##*/}
  printf '%s' "$b" | grep -Eqx '${RUNTIMES}' || continue
  n=$($S cat "$p/environ" 2>/dev/null | tr '\\000\\n' '\\n\\001' | cut -d= -f1 | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' | head -n 300 | tr '\\n' ' ')
  [ -n "$n" ] && printf 'P\\t%s\\t%s\\t%s\\n' "\${p#/proc/}" "$c" "$n"
done
`;

/** A path as one single-quoted shell word. @param {string} s */
const quoted = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The login, as the person typed it, checked for shape. @param {any} body
 * @returns {{ host: string, port: number, username: string, password?: string, privateKey?: string, passphrase?: string }}
 */
export function loginOf(body) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const host = str(body?.host).trim().replace(/^ssh:\/\//i, '').replace(/\/.*$/, '');
  const port = body?.port === undefined || body?.port === '' ? 22 : Number(body.port);
  const username = str(body?.username).trim();
  const privateKey = str(body?.privateKey).trim();
  const password = str(body?.password);
  if (!/^[A-Za-z0-9.:[\]-]{1,253}$/.test(host)) throw new OldServerError('Type the old server’s address (a name like old.example.com, or an IP address).');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OldServerError('The SSH port is a number from 1 to 65535 (usually 22).');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new OldServerError('Type the user name you sign in to the old server with (for example ubuntu or root).');
  if (!privateKey && !password) throw new OldServerError('Paste the private key, or type the password, you sign in to the old server with.');
  return { host, port, username, ...(privateKey ? { privateKey: `${privateKey}\n`, passphrase: str(body?.passphrase) || undefined } : { password }) };
}

/** A failure of ssh2 or the socket, in plain words. @param {any} err @param {{ host: string, port: number }} login */
function plain(err, { host, port }) {
  if (err instanceof OldServerError) return err;
  if (err instanceof BlockedAddressError) return new OldServerError(`${host} is a ${err.kind} address. Only a server on the internet can be read.`);
  if (err?.code === 'ENOTFOUND') return new OldServerError(`No server is found at ${host}. Check the address.`);
  if (err?.code === 'ECONNREFUSED') return new OldServerError(`Nothing answers SSH at ${host} on port ${port}.`);
  if (err?.level === 'client-timeout' || err?.code === 'ETIMEDOUT') return new OldServerError(`${host} did not answer on port ${port}. Its firewall may allow SSH only from some addresses.`);
  if (err?.level === 'client-authentication') return new OldServerError('The old server did not accept this user name with this key or password.');
  if (/private ?key|passphrase|Unsupported key|Cannot parse/i.test(err?.message ?? '')) return new OldServerError('This private key could not be read. Paste the whole key, and its passphrase if it has one.');
  return new OldServerError(`The old server could not be reached: ${err?.message ?? err}`);
}

/**
 * Signs in, runs one script (`sh -s`, the script on its input) and signs out. Its output as bytes, at most outputBytes.
 * @param {ReturnType<typeof loginOf>} login @param {string} script
 * @returns {Promise<{ out: Buffer, fingerprint: string }>}
 */
async function runOnce(login, script) {
  let fingerprint = '';
  let socket;
  try {
    // Connected to the checked address itself, so a name cannot resolve to another address between the check and the connection.
    const [{ address }] = await resolveChecked(login.host, login.port);
    socket = net.connect({ host: address, port: login.port });
  } catch (err) {
    throw plain(err, login);
  }
  const client = new Client();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.end();
      socket.destroy();
      if (err) reject(plain(err, login));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new OldServerError(`The old server took longer than ${OLD_SERVER_LIMITS.runMs / 1000} s. Nothing was copied.`)), OLD_SERVER_LIMITS.connectMs + OLD_SERVER_LIMITS.runMs);
    client.on('error', (err) => finish(err));
    socket.on('error', (err) => finish(err));
    client.on('ready', () => {
      client.exec('sh -s', (err, stream) => {
        if (err) return finish(err);
        const chunks = [];
        let size = 0;
        stream.on('data', (/** @type {Buffer} */ c) => {
          size += c.length;
          if (size > OLD_SERVER_LIMITS.outputBytes) return finish(new OldServerError('The old server answered with more than Remastly reads. Nothing was copied.'));
          chunks.push(c);
        });
        stream.stderr.resume();
        stream.on('close', () => finish(null, { out: Buffer.concat(chunks), fingerprint }));
        stream.end(script);
      });
    });
    try {
      client.connect({
        sock: socket,
        username: login.username,
        ...(login.privateKey ? { privateKey: login.privateKey, passphrase: login.passphrase } : { password: login.password }),
        readyTimeout: OLD_SERVER_LIMITS.connectMs,
        // Any host key is taken (the person chose this server); its fingerprint is shown, so they can tell it is theirs.
        hostVerifier: (/** @type {Buffer} */ key) => {
          fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          return true;
        },
      });
    } catch (err) {
      // A key that cannot be parsed (or a wrong passphrase) is thrown here, not emitted.
      finish(err);
    }
  });
}

/** Whether the script could read through sudo, from its first line. @param {string[]} lines */
const sudoOf = (lines) => lines.some((l) => l === 'SUDO\tyes');

/**
 * The settings files and running app programs on the old server, best first: names only, never a value.
 * @param {ReturnType<typeof loginOf>} login @param {string[]} wanted  the names the app's code reads
 */
export async function findSettings(login, wanted) {
  const { out, fingerprint } = await runOnce(login, FIND_SCRIPT);
  const lines = out.toString('utf8').split('\n');
  const want = new Set(wanted);
  const seen = new Set();
  const sources = [];
  for (const line of lines) {
    const [kind, ...rest] = line.split('\t');
    if (kind === 'F') {
      const [path, readable, names = ''] = rest;
      sources.push({ kind: 'file', path, readable: readable === '1', names: names.split(' ').filter(Boolean) });
    } else if (kind === 'P') {
      const [pid, command, names = ''] = rest;
      const list = names.split(' ').filter(Boolean);
      // The workers of one app (PM2 cluster, a supervisor and its child) share their settings: listed once.
      const key = `${command}\n${[...list].sort().join(' ')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ kind: 'program', pid: Number(pid), command: command.trim(), readable: true, names: list });
    }
  }
  const ranked = sources
    .map((s) => ({ ...s, names: [...new Set(s.names)] }))
    .map((s) => ({ ...s, matches: s.names.filter((n) => want.has(n)) }))
    // A readable source holding none of the app's names (another app's .env, a system program) is no candidate.
    .filter((s) => s.matches.length || !s.readable)
    .sort((a, b) => b.matches.length - a.matches.length || Number(b.readable) - Number(a.readable) || a.names.length - b.names.length)
    .slice(0, OLD_SERVER_LIMITS.sources)
    .map(({ names, ...s }) => ({ ...s, count: names.length }));
  return { fingerprint, sudo: sudoOf(lines), sources: ranked };
}

/**
 * The settings of one file or running program on the old server: names → values.
 * @param {ReturnType<typeof loginOf>} login @param {{ kind: 'file', path: string } | { kind: 'program', pid: number }} source
 * @param {(text: string) => Record<string, string>} parseEnvText
 * @returns {Promise<Record<string, string>>}
 */
export async function readSettings(login, source, parseEnvText) {
  let read;
  if (source?.kind === 'file' && typeof source.path === 'string' && /^\/[^\0\n]{1,1024}$/.test(source.path)) {
    read = `$S head -c ${OLD_SERVER_LIMITS.fileBytes} -- ${quoted(source.path)}`;
  } else if (source?.kind === 'program' && Number.isInteger(source.pid) && source.pid > 0) {
    read = `$S cat /proc/${source.pid}/environ`;
  } else {
    throw new OldServerError('Choose a settings file or a running program from the list.');
  }
  // The read's output starts after a marker line, so the sudo line never mixes with the file.
  const { out } = await runOnce(login, `${SUDO}\nprintf 'BEGIN\\n'\n${read} 2>/dev/null || printf '\\nSAS_READ_FAILED\\n'\n`);
  const at = out.indexOf('BEGIN\n');
  const body = at < 0 ? Buffer.alloc(0) : out.subarray(at + 'BEGIN\n'.length);
  const text = body.toString('utf8');
  if (/\nSAS_READ_FAILED\n$/.test(`\n${text}`)) {
    throw new OldServerError(source.kind === 'file'
      ? `${source.path} could not be read with this login${sudoOf(out.toString('utf8').split('\n')) ? '' : ' (and it may not use sudo)'}.`
      : 'That program has ended or could not be read. Look for it again.');
  }
  if (source.kind === 'file') return parseEnvText(text);
  // A program's environment: NAME=value entries separated by NUL bytes; a value may hold "=" or line breaks.
  /** @type {Record<string, string>} */
  const values = {};
  for (const entry of text.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, eq))) values[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return values;
}
