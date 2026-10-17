// Serves a lifted page folder (behavior/preserve/pageLift.js output) on 127.0.0.1 and prints its address, so the page can be
// checked by hand. Stop with Ctrl+C.
//   npm run preview:lift -w server -- <folder>        (folder = the lifted page, the one with index.html)
import path from 'node:path';
import { existsSync } from 'node:fs';
import { serveFolder } from '../src/recreate/behavior/preserve/render.js';

const folder = process.argv[2];
if (!folder || !existsSync(path.join(path.resolve(folder), 'index.html'))) {
  console.error('usage: npm run preview:lift -w server -- <folder with index.html>');
  process.exit(2);
}
const server = await serveFolder(path.resolve(folder));
console.log(`Lifted page: ${server.url}index.html`);
console.log('Serving on 127.0.0.1 only. Ctrl+C to stop.');
process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
