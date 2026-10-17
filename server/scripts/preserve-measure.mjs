// Attribution of a page's excluded parts (behavior/preserve/attribution.js): loads the page with the given hosts blocked
// and writes <captureRoot>/<slug>/attribution.json. Needs the live site (one browser at a time).
//   node scripts/preserve-measure.mjs <captureRoot> <slug> <pageUrl> <host> [host…]
import path from 'node:path';
import { chromium } from 'playwright';
import { measureAttribution } from '../src/recreate/behavior/preserve/attribution.js';

const [captureRoot, slug, pageUrl, ...hosts] = process.argv.slice(2);
if (!captureRoot || !slug || !pageUrl || !hosts.length) {
  console.error('usage: node scripts/preserve-measure.mjs <captureRoot> <slug> <pageUrl> <host> [host…]');
  process.exit(2);
}
const browser = await chromium.launch();
try {
  const outFile = path.join(path.resolve(captureRoot), slug, 'attribution.json');
  const result = await measureAttribution({ browser, url: pageUrl, hosts, outFile, settleMs: 4000 });
  console.log(JSON.stringify({ elements: result.elements, injected: result.injected, parts: result.parts.length }, null, 2));
} finally {
  await browser.close();
}
