// Where form submissions go, from the environment: MongoDB with MONGODB_URI, memory with FORMS_STORE=memory, else nowhere (the
// form endpoint answers 503 and the site is still served). Shared by `npm start` and `npm run dev`.
import { createMemoryStore, createMongoStore, disabledStore } from './store.js';

export async function openStore() {
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
