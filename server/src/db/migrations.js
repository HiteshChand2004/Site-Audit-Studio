// @ts-check
// Migrations still to come, in order. Empty in stage 0: nothing changes the database yet. Stage 1 (accounts, docs/HANDOFF.md)
// adds its own here, each additive (new tables, nullable columns, never a drop or a cascade from users), and each is proven on a
// copy by db/rehearse.js before it ever runs on a real database.
//
// A migration: { id: 'yyyy-mm-dd-name', up(db) } — up runs inside a transaction; it must be safe to run twice.

/** @type {{ id: string, up: (db: import('node:sqlite').DatabaseSync) => void }[]} */
export const MIGRATIONS = [];
