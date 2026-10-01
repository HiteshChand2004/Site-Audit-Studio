import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/limiter.js';
import { createMemoryStore, createMongoStore, disabledStore, StoreDisabledError } from '../src/store.js';

// A stand-in for the MongoDB driver: records what the store asks of it.
function fakeMongo({ failConnect = false, failInsert = false } = {}) {
  const log = { uri: null, options: null, db: null, collection: null, indexes: [], inserted: [], closed: false };
  class MongoClient {
    constructor(uri, options) {
      log.uri = uri;
      log.options = options;
    }

    async connect() {
      if (failConnect) throw new Error('connection refused');
    }

    db(name) {
      log.db = name;
      return {
        collection: (c) => {
          log.collection = c;
          return {
            createIndex: async (spec) => log.indexes.push(spec),
            insertOne: async (doc) => {
              if (failInsert) throw new Error('write failed');
              log.inserted.push(doc);
              return { insertedId: `id-${log.inserted.length}` };
            },
          };
        },
      };
    }

    async close() {
      log.closed = true;
    }
  }
  return { MongoClient, log };
}

test('the MongoDB store connects, indexes, inserts copies of documents and closes', async () => {
  const { MongoClient, log } = fakeMongo();
  const store = await createMongoStore({ uri: 'mongodb://db/x', dbName: 'site', collection: 'subs', MongoClient });
  assert.deepEqual([store.enabled, store.kind], [true, 'mongodb']);
  assert.deepEqual([log.uri, log.db, log.collection], ['mongodb://db/x', 'site', 'subs']);
  assert.deepEqual(log.indexes, [{ receivedAt: -1 }]);
  assert.equal(log.options.serverSelectionTimeoutMS, 5000);
  const doc = { formId: 'contact-1', values: { name: 'Ada' }, receivedAt: new Date(0) };
  assert.equal(await store.insert(doc), 'id-1');
  assert.deepEqual(log.inserted[0], doc);
  assert.notEqual(log.inserted[0], doc); // the driver adds _id to what it gets; the caller's object stays clean
  await store.close();
  assert.equal(log.closed, true);
});

test('a missing URI or a failed connection is an error, a failed write reaches the caller', async () => {
  await assert.rejects(createMongoStore({ MongoClient: fakeMongo().MongoClient }), /MONGODB_URI/);
  await assert.rejects(createMongoStore({ uri: 'mongodb://db/x', MongoClient: fakeMongo({ failConnect: true }).MongoClient }), /connection refused/);
  const store = await createMongoStore({ uri: 'mongodb://db/x', MongoClient: fakeMongo({ failInsert: true }).MongoClient });
  await assert.rejects(store.insert({ a: 1 }), /write failed/);
});

test('the memory and disabled stores', async () => {
  const memory = createMemoryStore();
  const doc = { a: { b: 1 } };
  assert.equal(await memory.insert(doc), '1');
  doc.a.b = 2;
  assert.deepEqual(memory.docs, [{ a: { b: 1 } }]); // a copy
  const off = disabledStore();
  assert.deepEqual([off.enabled, off.kind], [false, 'disabled']);
  await assert.rejects(off.insert({}), StoreDisabledError);
});

test('the limiter allows `max` per window per key, then says when to retry', () => {
  let t = 0;
  const limiter = createLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, true);
  const blocked = limiter.take('a');
  assert.deepEqual([blocked.ok, blocked.retryAfter], [false, 1]);
  assert.equal(limiter.take('b').ok, true); // another client
  t = 1001;
  assert.equal(limiter.take('a').ok, true); // the window moved on
});
