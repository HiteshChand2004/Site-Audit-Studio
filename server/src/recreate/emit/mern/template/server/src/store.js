// Where form submissions go. A store has the same small interface whatever is behind it:
//   enabled   false = nothing is stored (the form endpoint answers 503)
//   kind      'mongodb' | 'memory' | 'disabled'
//   insert(doc) → id (string)
//   close()
// The MongoDB driver is loaded only when a MongoDB store is created, and a client can be passed in (the tests do).

export class StoreDisabledError extends Error {
  constructor() {
    super('Form storage is not configured.');
    this.name = 'StoreDisabledError';
  }
}

export function disabledStore() {
  return {
    enabled: false,
    kind: 'disabled',
    async insert() {
      throw new StoreDisabledError();
    },
    async close() {},
  };
}

/** Keeps submissions in memory (development and tests; lost when the process stops). */
export function createMemoryStore() {
  const docs = [];
  return {
    enabled: true,
    kind: 'memory',
    docs,
    async insert(doc) {
      docs.push(structuredClone(doc));
      return String(docs.length);
    },
    async close() {},
  };
}

/**
 * @param {{ uri: string, dbName?: string, collection?: string, MongoClient?: new (uri: string, options?: object) => object }} o
 */
export async function createMongoStore({ uri, dbName = 'site', collection = 'submissions', MongoClient } = {}) {
  if (!uri) throw new Error('A MongoDB connection string (MONGODB_URI) is required.');
  const Client = MongoClient ?? (await import('mongodb')).MongoClient;
  const client = new Client(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const submissions = client.db(dbName).collection(collection);
  await submissions.createIndex({ receivedAt: -1 });
  return {
    enabled: true,
    kind: 'mongodb',
    async insert(doc) {
      const result = await submissions.insertOne({ ...doc });
      return String(result.insertedId);
    },
    async close() {
      await client.close();
    },
  };
}
