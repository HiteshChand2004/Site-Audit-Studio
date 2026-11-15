// @ts-check
// The one-time setup of a server so Remastly hosts websites on it (Go live → "Remastly's own server"), written out with the
// values of the Remastly that shows it (its folders, user, Node, ports). Shown to the owner only (routes/deploy.js); nothing
// here runs anything: the owner runs these steps once, as root, on the server.
//
// What it sets up, and why each part is there:
//   nginx      every named domain no other server block names → the sites server (a regex name, never `default_server`: a
//              server's own catch-all for bare-IP scans and nameless requests stays as it is); HTTPS with the certificate of the name asked for,
//              read per connection from HOSTING_DIR/certs/<name>/ (so a new domain needs no reload); http → https once a
//              domain has its certificate, except Let's Encrypt's own check.
//   sites      the sites server as a service of its own (hosting/main.js), restarted if it stops.
//   certs      certbot, the official Let's Encrypt client, run every 5 minutes for the domains Remastly lists
//              (hosting/certs.js); its deploy hook copies each certificate where nginx reads it, on issue and on renewal
//              (certbot's own timer renews them).

import { realpathSync } from 'node:fs';

/**
 * The app folder a service should start from: the one that follows the live version. With release folders
 * (<root>/releases/<id>/server, and <root>/app a link to the live release, docs/DEPLOY-TOOL.md) that is <root>/app/server, so
 * after the next update the sites server runs the new code too; otherwise the folder as it is.
 * @param {string} serverDir  this process's server folder (its real path)
 * @param {(p: string) => string | null} [realpathOf]
 */
export function stableServerDir(serverDir, realpathOf = (p) => { try { return realpathSync(p); } catch { return null; } }) {
  const m = serverDir.match(/^(.*)\/releases\/[^/]+\/server$/);
  if (!m) return serverDir;
  const app = `${m[1]}/app`;
  return realpathOf(app) === serverDir.slice(0, -'/server'.length) ? `${app}/server` : serverDir;
}

const HOST_RE = '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$';

/**
 * @param {{ hostingDir: string, serverDir: string, node: string, user: string, email: string, ip: string | null, sitesPort: number }} v
 * @returns {{ files: { path: string, why: string, content: string }[], steps: { why: string, command: string }[], env: string[] }}
 */
export function serverSetup({ hostingDir, serverDir, node, user, email, ip, sitesPort }) {
  // These files run as root: every value written into them is a plain path, name or address, never anything a shell would read.
  const plain = (v, re, what) => {
    if (!re.test(String(v))) throw new Error(`The ${what} cannot be written into the setup: ${v}`);
    return v;
  };
  plain(hostingDir, /^\/[A-Za-z0-9._/-]+$/, 'hosting folder');
  plain(serverDir, /^\/[A-Za-z0-9._/-]+$/, 'app folder');
  plain(node, /^\/[A-Za-z0-9._/-]+$/, 'Node path');
  plain(user, /^[a-z_][a-z0-9_-]*$/, 'user');
  plain(email, /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, 'email');
  plain(sitesPort, /^\d{2,5}$/, 'port');
  const nginx = `# Remastly: the websites Remastly hosts itself (Go live -> "Remastly's own server").
# Every named domain no other server block names comes here (an exact server_name elsewhere always wins over this pattern);
# the sites server on 127.0.0.1:${sitesPort} answers the ones Remastly hosts. Not the default server: a request by bare IP or
# with no name keeps going to the server's own catch-all, if it has one.
server {
    listen 80;
    listen [::]:80;
    server_name ~^.+$;
    location / {
        # Once a domain has its certificate, visitors go to https; Let's Encrypt's own check stays on http.
        set $to_https 0;
        if (-f ${hostingDir}/certs/$host/fullchain.pem) { set $to_https 1; }
        if ($request_uri ~ "^/\\.well-known/acme-challenge/") { set $to_https 0; }
        if ($to_https = 1) { return 301 https://$host$request_uri; }
        proxy_pass http://127.0.0.1:${sitesPort};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ~^.+$;
    # The certificate of the name the visitor asked for, read on each connection: a new domain needs no reload.
    ssl_certificate     ${hostingDir}/certs/$ssl_server_name/fullchain.pem;
    ssl_certificate_key ${hostingDir}/certs/$ssl_server_name/privkey.pem;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:${sitesPort};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
`;

  const certs = `#!/bin/sh
# Remastly: a Let's Encrypt certificate for each domain in certs-wanted.txt, the hosted domains that already point to this
# server (written by Remastly). Run every 5 minutes by remastly-certs.timer.
set -eu
HOSTING='${hostingDir}'
STATE=/var/lib/remastly-certs
mkdir -p "$STATE"
[ -f "$HOSTING/certs-wanted.txt" ] || exit 0
while IFS= read -r host; do
  # A plain domain name only: checked again here, before it reaches certbot's command line.
  printf '%s' "$host" | grep -Eq '${HOST_RE}' || continue
  [ -f "$HOSTING/certs/$host/fullchain.pem" ] && continue
  # One try an hour per domain at most: Let's Encrypt limits failed checks.
  tried="$STATE/$host.tried"
  if [ -f "$tried" ] && [ $(( $(date +%s) - $(stat -c %Y "$tried") )) -lt 3600 ]; then continue; fi
  touch "$tried"
  certbot certonly --webroot -w "$HOSTING/acme" -d "$host" --cert-name "$host" \\
    --non-interactive --agree-tos -m '${email}' --keep-until-expiring \\
    --deploy-hook /usr/local/sbin/remastly-certs-deploy || echo "remastly-certs: no certificate for $host yet"
done < "$HOSTING/certs-wanted.txt"
`;

  const deploy = `#!/bin/sh
# Remastly: copies a certificate certbot just issued or renewed to where nginx reads it (certbot sets RENEWED_LINEAGE).
set -eu
HOSTING='${hostingDir}'
name=$(basename "$RENEWED_LINEAGE")
printf '%s' "$name" | grep -Eq '${HOST_RE}' || exit 0
dir="$HOSTING/certs/$name"
mkdir -p "$dir"
# The key first, then the chain: Remastly and nginx take a domain as ready once fullchain.pem is there.
cp -L "$RENEWED_LINEAGE/privkey.pem" "$dir/privkey.pem.tmp" && mv "$dir/privkey.pem.tmp" "$dir/privkey.pem"
cp -L "$RENEWED_LINEAGE/fullchain.pem" "$dir/fullchain.pem.tmp" && mv "$dir/fullchain.pem.tmp" "$dir/fullchain.pem"
# nginx (www-data) reads the key; Remastly only needs to see the chain.
chown root:www-data "$dir" "$dir/privkey.pem" "$dir/fullchain.pem"
chmod 755 "$dir"
chmod 640 "$dir/privkey.pem"
chmod 644 "$dir/fullchain.pem"
`;

  const sitesUnit = `[Unit]
Description=Remastly sites server (the websites Remastly hosts)
After=network.target

[Service]
User=${user}
WorkingDirectory=${serverDir}
Environment=SAS_HOSTING_DIR=${hostingDir}
Environment=SAS_SITES_PORT=${sitesPort}
ExecStart=${node} src/hosting/main.js
Restart=always

[Install]
WantedBy=multi-user.target
`;

  const certsUnit = `[Unit]
Description=Remastly: certificates for newly pointed domains

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/remastly-certs
`;

  const certsTimer = `[Unit]
Description=Remastly: look for domains that need a certificate every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
`;

  return {
    files: [
      { path: '/etc/nginx/sites-available/remastly-sites', why: 'nginx: sends hosted domains to the sites server, with their padlock', content: nginx },
      { path: '/usr/local/sbin/remastly-certs', why: 'gets a certificate for each domain that points here', content: certs },
      { path: '/usr/local/sbin/remastly-certs-deploy', why: 'puts each new or renewed certificate where nginx reads it', content: deploy },
      { path: '/etc/systemd/system/remastly-sites.service', why: 'keeps the sites server running', content: sitesUnit },
      { path: '/etc/systemd/system/remastly-certs.service', why: 'runs the certificate script', content: certsUnit },
      { path: '/etc/systemd/system/remastly-certs.timer', why: 'runs it every 5 minutes', content: certsTimer },
    ],
    steps: [
      { why: 'Install certbot (Let\'s Encrypt\'s official tool)', command: 'sudo apt-get update && sudo apt-get install -y certbot' },
      { why: 'Make the hosting folder, owned by the user Remastly runs as, readable by nginx', command: `sudo mkdir -p ${hostingDir}/acme ${hostingDir}/certs && sudo chown -R ${user} ${hostingDir} && sudo chmod 755 ${hostingDir} ${hostingDir}/acme ${hostingDir}/certs` },
      { why: 'Save the six files below (with sudo), then make the two scripts runnable', command: 'sudo chmod 755 /usr/local/sbin/remastly-certs /usr/local/sbin/remastly-certs-deploy' },
      { why: 'Turn the nginx part on and check it before reloading', command: 'sudo ln -sf /etc/nginx/sites-available/remastly-sites /etc/nginx/sites-enabled/remastly-sites && sudo nginx -t && sudo systemctl reload nginx' },
      { why: 'Start the sites server and the certificate timer, now and after every reboot', command: 'sudo systemctl daemon-reload && sudo systemctl enable --now remastly-sites.service remastly-certs.timer' },
      { why: 'Tell Remastly it hosts (add these two lines to its settings, then restart it)', command: 'see "Remastly\'s settings" below' },
    ],
    env: [`SAS_HOSTING_IP=${ip ?? '<this server\'s public IP address>'}`, `SAS_HOSTING_DIR=${hostingDir}`],
  };
}
