// Starts the server: the built site and the form endpoint.
//   PORT               default 3000
//   SITE_DIR           the built site, default ../client/dist (run `npm run build` in client/ first)
//   MONGODB_URI        where submissions are stored; without it the form endpoint answers 503 (the site still works)
//   FORMS_DB           database name, default "site";  FORMS_COLLECTION  default "submissions"
//   FORMS_STORE=memory keep submissions in memory instead (development; lost on restart)
//   TRUST_PROXY        set to "true" (or a hop count) behind a reverse proxy, so the rate limit sees the real client address
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createMemoryStore, createMongoStore, disabledStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const forms = JSON.parse(readFileSync(path.join(here, '..', 'forms.json'), 'utf8'));
const siteDir = path.resolve(process.env.SITE_DIR ?? path.join(here, '..', '..', 'client', 'dist'));
const port = Number(process.env.PORT ?? 3000);

async function openStore() {
  if (process.env.MONGODB_URI) {
    try {
      const store = await createMongoStore({ uri: process.env.MONGODB_URI, dbName: process.env.FORMS_DB, collection: process.env.FORMS_COLLECTION });
      console.log('Form submissions are stored in MongoDB.');
      return store;
    } catch (err) {
      // The site must not go down with the database: serve it, and say why the forms do not work.
      console.error(`Could not connect to MongoDB (${err.message}). Forms are disabled; the site is still served.`);
      return disabledStore();
    }
  }
  if (process.env.FORMS_STORE === 'memory') {
    console.log('Form submissions are kept in memory (FORMS_STORE=memory).');
    return createMemoryStore();
  }
  console.log('Forms are disabled: set MONGODB_URI to store submissions.');
  return disabledStore();
}

const store = await openStore();
const server = createApp({ store, forms, siteDir }).listen(port, () => console.log(`Serving ${siteDir} on http://localhost:${port}`));

const stop = () => {
  server.close(() => store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
