// @ts-check
// The one-time setup of a server so Remastly can run websites' back offices in boxes (Go live → "Move logins and data to
// Remastly"), shown to the owner on the card while Docker is missing. Nothing here runs anything: the owner runs these
// steps once on the server. Steps without a command are said in words (they depend on how the server is set up).
import { IMAGES } from './box.js';

/** @param {{ user: string }} v @returns {{ why: string, command: string }[]} */
export function boxSetup({ user }) {
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error(`The user cannot be written into the setup: ${user}`);
  return [
    { why: 'Install Docker, which runs each website\'s back office in a sealed box of its own', command: 'sudo apt-get update && sudo apt-get install -y docker.io && sudo systemctl enable --now docker' },
    { why: `Let Remastly's user (${user}) start and stop the boxes. This gives it full control of Docker, which is as much as root on this server: keep the server for Remastly.`, command: `sudo usermod -aG docker ${user}` },
    { why: 'Download the two parts every box is made of, once, so the first box starts quickly', command: `sudo -u ${user} docker pull ${IMAGES.db} && sudo -u ${user} docker pull ${IMAGES.web}` },
    { why: 'Let large backups through to Remastly: in the nginx settings of Remastly\'s own address, inside its /api/ part, add "client_max_body_size 8g; proxy_request_buffering off; proxy_read_timeout 600s;", then check and reload nginx (sudo nginx -t && sudo systemctl reload nginx)', command: '' },
    { why: 'Restart Remastly so it can use Docker (when no copy is running)', command: '' },
  ];
}
