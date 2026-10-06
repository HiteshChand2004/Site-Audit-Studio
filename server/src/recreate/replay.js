// Rebuild from a saved capture: the inspect and assets steps of an earlier recreate are replayed from its folder (capture/,
// assets/ and their manifests) instead of opening the site again, so only generate → build → preview run. For trying a
// change to the generated site in seconds instead of a full Recreate; general for any project, nothing is site-specific.
// The files are hard-linked into the new workspace (copied where links are not possible), so the new recreate can serve
// as the source of the next rebuild after the old one is pruned.
import { copyFile, link, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { RecreateError } from './errors.js';

/** Hard-links (or copies) every file of `from` into `to`. Returns the number of files. */
async function linkTree(from, to) {
  await mkdir(to, { recursive: true });
  let n = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) n += await linkTree(a, b);
    else if (entry.isFile()) {
      await link(a, b).catch(() => copyFile(a, b));
      n++;
    }
  }
  return n;
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/** Can the recreate in `dir` be rebuilt from (its capture and asset manifests are there)? */
export async function canReplay(dir) {
  try {
    await stat(path.join(dir, 'capture', 'manifest.json'));
    await stat(path.join(dir, 'assets', 'manifest.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The inspect and assets stages replaced by replays of the recreate in `sourceDir` (recreate/index.js STAGES shape).
 * @param {string} sourceDir  data/projects/<id>/recreate/<recreateId>
 * @param {{ recreateId: string, createdAt?: string }} source
 */
export function replayStages(sourceDir, source) {
  return {
    inspect: async (ctx) => {
      ctx.progress(0, 'Reusing the saved capture');
      const manifest = await readJson(path.join(sourceDir, 'capture', 'manifest.json')).catch(() => null);
      if (!manifest?.pages?.length) throw new RecreateError('The saved capture cannot be read: run a full Recreate.');
      const before = await readJson(path.join(sourceDir, 'report.json')).catch(() => ({}));
      const files = await linkTree(path.join(sourceDir, 'capture'), path.join(ctx.dir, 'capture'));
      const d = manifest.discovery ?? {};
      ctx.pages = manifest.pages;
      // What the generate step reads from discovery; robots / llms are in manifests written since the rebuild mode exists.
      ctx.discovery = { origin: manifest.origin, homeUrl: manifest.homeUrl, skipped: d.skipped ?? [], robots: d.robots ?? null, llms: d.llms ?? null };
      // Captures made before robots / llms were kept in the manifest: the earlier build's own result stands in for them.
      if (!d.robots) {
        const item = (before.fixes ?? []).find((f) => f.id === 'crawl-files')?.items?.find((i) => i.file === 'robots.txt');
        if (item) ctx.discovery.robots = { status: 'found', blocksAll: Boolean(item.blocksAll), blockedAiCrawlers: item.blockedAiCrawlers ?? [] };
      }
      if (!d.llms) {
        const text = await readFile(path.join(sourceDir, 'site', 'llms.txt'), 'utf8').catch(() => null);
        if (text) ctx.discovery.llms = { found: true, text, tooLarge: false };
      }
      ctx.livePages = (d.linksToLive ?? []).map((p) => ({ url: p.url, reason: p.reason }));
      const r = ctx.report;
      r.reusedCapture = { recreateId: source.recreateId, capturedAt: before.createdAt ?? source.createdAt ?? null, files };
      r.pages = before.pages ?? manifest.pages.map((p) => ({ url: p.url, path: p.path, outPath: p.outPath, slug: p.slug, title: p.title, source: p.source, views: Object.keys(p.views ?? {}) }));
      r.motion = before.motion ?? null;
      r.discovery = before.discovery ?? d;
      r.blockedHosts = before.blockedHosts ?? [];
      r.manual.push(...(before.manual ?? []).filter((m) => m.kind === 'page'));
      r.warnings.push(`Rebuilt from the capture of ${r.reusedCapture.capturedAt ? new Date(r.reusedCapture.capturedAt).toLocaleString('en-GB') : 'an earlier recreate'}: the site was not opened again. Run a full Recreate to pick up changes on the live site.`);
      // The same manifest in the new workspace: this recreate can be the source of the next rebuild.
      ctx.progress(1, `Reused the capture of ${manifest.pages.length} ${manifest.pages.length === 1 ? 'page' : 'pages'}`);
    },
    assets: async (ctx) => {
      ctx.progress(0, 'Reusing the downloaded files');
      const root = path.join(ctx.dir, 'assets');
      await linkTree(path.join(sourceDir, 'assets'), root);
      const m = await readJson(path.join(root, 'manifest.json'));
      const before = await readJson(path.join(sourceDir, 'report.json')).catch(() => ({}));
      ctx.assets = { dir: root, map: m.map, files: m.files, skipped: m.skipped, fontFaces: m.fontFaces, keyframes: m.keyframes, svg: before.assets?.svg ?? null };
      ctx.report.assets = before.assets ?? { downloaded: m.files.length };
      ctx.report.manual.push(...(before.manual ?? []).filter((x) => x.kind === 'asset'));
      ctx.progress(1, `Reused ${m.files.length} ${m.files.length === 1 ? 'file' : 'files'}`);
    },
  };
}
