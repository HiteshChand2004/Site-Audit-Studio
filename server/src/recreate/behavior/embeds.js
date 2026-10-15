// @ts-check
// generate.js's one call for self-running layers (CLONER_SPEC Phase 2 items 3 and 9): Lottie animations the copy plays
// with lottie-web (behavior/lottie.js) come first; every other self-running layer the capture recorded - and a Lottie
// whose JSON was not found - plays its recording (behavior/video.js). Everything is reported: what plays as a recording is
// "approximated", and each page's share of clean / approximated / islands is in `report.composition`.
import { planLottie, applyLottiePages, LOTTIE_PACKAGE_VERSION } from './lottie.js';
import { applyVideoTier, compositionOf, planVideoTier } from './video.js';
import { MOTION_VERSION } from '../ir/motion.js';

const MOTION_BASE = { hover: [], focus: [], reveal: [], delays: [], loops: [], widgets: [], states: 0, notices: 0, panels: 0, hoverCards: 0, scrolled: [], script: false };

/**
 * Plans the page's embeds and recordings on the site trees (motion tokens `oN` / `vN`), copies the recordings into the
 * assets, switches the generated script on, and writes the report.
 * @param {{ pages: object[], motion?: object }} site
 * @param {Map<string, object>} motionByPath
 * @param {{ ctx: any, assetsDir: string, known: any, report: any, canvasRules?: object[], addToManifest: Function }} o
 */
export async function planEmbeds(site, motionByPath, { ctx, assetsDir, known, report, canvasRules = [], addToManifest }) {
  const lottie = await planLottie(site, motionByPath, { dir: ctx.dir, lookup: (url) => ctx.netCache?.lookup?.(url) ?? null });
  const video = await planVideoTier(site, motionByPath, { dir: ctx.dir, assetsDir, embedded: lottie.embedded });
  if (video.files.length) await addToManifest(assetsDir, video.files, known, ctx.assets);
  // A canvas that plays its video needs no animated picture of itself as well (its still frame stays, under the poster).
  if (video.rules.length && canvasRules.length) {
    const withVideo = new Set();
    const walk = (n) => {
      if (!n || 'text' in n) return;
      if ((n.motionTokens ?? []).some((t) => /^v\d+$/.test(t))) for (const t of n.motionTokens) if (/^c\d+$/.test(t)) withVideo.add(t);
      (n.children ?? []).forEach(walk);
    };
    for (const t of site.pages) walk(t.root);
    for (const r of canvasRules) if (withVideo.has(r.token)) delete r.loop;
  }
  if (video.rules.length || lottie.programs.size) {
    site.motion = { version: MOTION_VERSION, ...MOTION_BASE, ...site.motion, script: true, ...(video.rules.length && { video: video.rules }), ...(lottie.programs.size && { lottie: true }) };
  }
  const composition = compositionOf(site, video.entries);
  report.composition = composition;
  for (const p of report.pages ?? []) if (composition[p.path]) p.composition = composition[p.path];
  if (video.entries.length || video.skipped.length || lottie.entries.length || lottie.skipped.length) {
    report.motion = {
      ...report.motion,
      ...(video.entries.length && { approximated: video.entries }),
      video: { played: video.entries.length, skipped: video.skipped },
      ...((lottie.entries.length || lottie.skipped.length) && { lottie: { lib: 'lottie-web', version: LOTTIE_PACKAGE_VERSION, embedded: lottie.entries, skipped: lottie.skipped } }),
    };
  }
  if (video.entries.length) {
    report.manual.push({
      area: 'Animation',
      title: `${video.entries.length} self-running ${video.entries.length === 1 ? 'layer plays' : 'layers play'} as a recording (approximated)`,
      detail: 'What the original drew with its own script (a canvas, a shape reshaped frame by frame, an animation without its data) is shown as a short looping video recorded from the original, behind the real text, buttons and links. It does not react to the visitor, and a visitor who asks for less motion sees its first frame only.',
      count: video.entries.length,
    });
  }
  const notEmbedded = lottie.skipped.filter((s) => s.reason !== 'not-self-running');
  if (notEmbedded.length) {
    report.warnings.push(`${notEmbedded.length} Lottie ${notEmbedded.length === 1 ? 'animation was' : 'animations were'} not played with lottie-web (${[...new Set(notEmbedded.map((s) => s.reason))].join(', ')}); ${notEmbedded.length === 1 ? 'it shows' : 'they show'} the recording or the frame the capture saw instead.`);
  }
  return { lottie: lottie.programs, video: video.rules };
}

/** On a built IR (and again on an as-is one): each page's Lottie program, and the layers that become their videos. */
export function applyEmbeds(ir, embeds) {
  if (!embeds) return;
  applyLottiePages(ir, embeds.lottie);
  applyVideoTier(ir, embeds.video);
}
