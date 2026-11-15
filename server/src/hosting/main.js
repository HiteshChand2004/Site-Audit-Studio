// @ts-check
// Starts the sites server on its own (npm run sites -w server): every website Remastly hosts, on 127.0.0.1:SAS_SITES_PORT
// (default 4100), for nginx to send their domains to. A process of its own, so the app's restarts and jobs never stop them.
import { HOSTING_DIR } from '../config/paths.js';
import { startSitesServer } from './server.js';

const port = Number(process.env.SAS_SITES_PORT) || 4100;
await startSitesServer({ port });
console.log(`Sites server on http://127.0.0.1:${port}, serving ${HOSTING_DIR}`);
