// Step (a) of the preserve-original work, from the command line: extracts every animated / reactive component of a
// captured page into <out>/preserved/<id>/ (markup, CSS, files, manifest) and prints the index.
//   node scripts/preserve-extract.mjs <captureRoot> <pageUrl> <outDir> [slug=index] [view=desktop]
// <captureRoot> is the job's capture folder (it holds .network/ and <slug>/). Reads only; nothing is fetched.
import path from 'node:path';
import { preserveCapture } from '../src/recreate/behavior/preserve/index.js';

const [captureRoot, pageUrl, outDir, slug = 'index', view = 'desktop'] = process.argv.slice(2);
if (!captureRoot || !pageUrl || !outDir) {
  console.error('usage: node scripts/preserve-extract.mjs <captureRoot> <pageUrl> <outDir> [slug] [view]');
  process.exit(2);
}
const index = await preserveCapture({ captureRoot: path.resolve(captureRoot), slug, view, outDir: path.resolve(outDir), pageUrl });
console.log(JSON.stringify(index, null, 2));
