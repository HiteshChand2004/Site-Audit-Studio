// Starts the server: the built site, the form endpoint and the owner's page of submissions (/admin).
//   PORT               default 3000
//   SITE_DIR           the built site, default ../client/dist (run `npm run build` first)
//   MONGODB_URI        where submissions are stored; without it the forms answer 503 (the site still works)
//   FORMS_DB           database name, default "site";  FORMS_COLLECTION  default "submissions"
//   FORMS_STORE=memory keep submissions in memory instead (trying it out; lost on restart)
//   ADMIN_PASSWORD     the password of /admin (at least 12 characters); without it /admin does not exist
//   TRUST_PROXY        set to "true" (or a hop count) behind a reverse proxy, so the limits see the real visitor's address
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';
import { createAdmin, listerFor, MIN_PASSWORD } from './admin.js';
import { createMemoryStore, createMongoStore, disabledStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const forms = JSON.parse(readFileSync(path.join(here, '..', 'forms.json'), 'utf8'));
const siteDir = path.resolve(process.env.SITE_DIR ?? path.join(here, '..', '..', 'client', 'dist'));
const port = Number(process.env.PORT ?? 3000);
const mongo = { uri: process.env.MONGODB_URI, dbName: process.env.FORMS_DB, collection: process.env.FORMS_COLLECTION };

async function openStore() {
  if (mongo.uri) {
    try {
      const store = await createMongoStore(mongo);
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
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
const admin = createAdmin({ password: process.env.ADMIN_PASSWORD, forms, list: listerFor(store, mongo) });
if (admin) app.use('/admin', admin);
else console.log(`/admin is off: set ADMIN_PASSWORD (at least ${MIN_PASSWORD} characters) to read form submissions there.`);
app.use(createApp({ store, forms, siteDir }));
const server = app.listen(port, () => console.log(`Serving ${siteDir} on http://localhost:${port}`));

const stop = () => {
  server.close(() => store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
