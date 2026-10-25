// `npm start`: the built site (client/dist, written by `npm run build`) and the form endpoint.
//   PORT               default 3000
//   HOST               default all addresses
//   SITE_DIR           the built site, default ../../client/dist
//   MONGODB_URI        where submissions are stored; without it the form endpoint answers 503 (the site still works)
//   FORMS_DB           database name, default "site";  FORMS_COLLECTION  default "submissions"
//   FORMS_STORE=memory keep submissions in memory instead (trying it out; lost on restart)
//   TRUST_PROXY        set to "true" (or a hop count) behind a reverse proxy, so the rate limit sees the real client address
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openStore } from './open-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const forms = JSON.parse(readFileSync(path.join(here, '..', 'forms.json'), 'utf8'));
const siteDir = path.resolve(process.env.SITE_DIR ?? path.join(here, '..', '..', 'client', 'dist'));
const port = Number(process.env.PORT ?? 3000);

if (!existsSync(siteDir)) {
  console.error(`${siteDir} does not exist: run \`npm run build\` first.`);
  process.exit(1);
}

const store = await openStore();
const server = createApp({ store, forms, siteDir }).listen(port, process.env.HOST, () => console.log(`Serving ${siteDir} on http://${process.env.HOST ?? 'localhost'}:${port}`));

const stop = () => {
  server.close(() => store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
