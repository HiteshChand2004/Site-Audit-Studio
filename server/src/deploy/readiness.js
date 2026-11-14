// @ts-check
// Before a copy goes live: what stops it (blockers: there is nothing deployable, or it did not pass its safety check: an as-is
// copy that still asks the original site, see copy/outsideServices.js) and what
// the owner should know first (warnings, each accepted by its id in the deploy request). The copy's goal is to be better than the
// original, so a copy that names the original's address, got worse somewhere, was never compared, or has forms that send
// nothing is not stopped, but it is not deployed without the owner saying they saw that.
import { formCounts } from '../copy/formRoutes.js';
import { outsideLine } from '../copy/outsideServices.js';
import { markOutside } from '../copy/gotWorse.js';
import { reportOutputs } from '../recreate/export/fromIr.js';
import { STATIC_STACKS } from './bundle.js';

// The causes Results shows apart from "got worse" (client siteData.js WORSE_CAUSES).
const EXPLAINED = new Set(['measurement', 'needs-info', 'look', 'own-code', 'impossible']);

/**
 * @param {{ project: any, report: any | null, stack: string, reaudit: any | null }} o
 *   `reaudit` = the latest finished comparison of this copy (its result), or null
 * @returns {{ ok: boolean, blockers: { id: string, text: string }[], warnings: { id: string, text: string }[] }}
 */
export function deployReadiness({ project, report, stack, reaudit }) {
  const blockers = [];
  const warnings = [];
  if (!report) {
    blockers.push({ id: 'no-copy', text: 'There is no finished copy yet. Create the copy first.' });
    return { ok: false, blockers, warnings };
  }
  if (reportOutputs(report)[stack]?.status !== 'ready') blockers.push({ id: 'no-output', text: `This copy has no finished ${stack} version.` });
  else if (!STATIC_STACKS.has(stack)) blockers.push({ id: 'needs-server', text: 'A MERN copy needs its own Node server and database; Netlify serves plain files only. Deploy the plain HTML, React or Next.js version, or download the MERN project.' });
  if (report.safety?.safe !== true) {
    const asksOriginal = report.safety?.original?.length;
    blockers.push({ id: 'unsafe', text: asksOriginal
      ? `This copy still asks the original site for ${asksOriginal === 1 ? 'one file' : `${asksOriginal} files`} (for example ${report.safety.original[0]}). Once the copy replaces the original, nothing answers ${asksOriginal === 1 ? 'it' : 'them'}. Make the copy again.`
      : 'This copy did not pass its safety check, so it is not published. Make the copy again.' });
  }
  // Outside services the site uses (as-is copy: visitor counting, fonts, a chat widget…): kept, and confirmed by the owner.
  const outside = report.safety?.safe === true ? (report.safety.outside ?? []) : [];
  if (outside.length) {
    const locked = outside.filter((o) => o.domainLocked).map((o) => o.host);
    warnings.push({
      id: 'outside',
      text: `The copy still uses ${outside.length === 1 ? 'an outside service' : `${outside.length} outside services`} the original uses: ${outside.map(outsideLine).join('; ')}. They keep working on your real address.${locked.length ? ` ${locked.join(', ')} ${locked.length === 1 ? 'answers' : 'answer'} only your real address, so ${locked.length === 1 ? 'it does' : 'they do'} not show on a test address such as a netlify.app link.` : ''}`,
    });
  }

  const address = report.asIs ? (report.asIs.address?.used ?? null) : (project?.target_domain || null);
  if (!address) {
    warnings.push({ id: 'address', text: 'The copy was made without the new site\'s address, so its canonical tags, sitemap.xml and share images still name the original site. Search engines may keep sending people there. Give the copy its address and make it again to fix this.' });
  }
  if (!reaudit) {
    warnings.push({ id: 'not-compared', text: 'This copy has not been compared with the original yet, so nothing shows it is better. Run "Compare now" first to be sure.' });
  } else {
    // Counted as Results counts them (client siteData.js worseSplit): not the rows outside what the tool can change, not the
    // ones with a known reason that is not the copy being worse (measured on this computer, needs the address, kept as the look).
    const checklist = markOutside(structuredClone(reaudit.checklist ?? {}));
    const worse = (checklist.items ?? []).filter((i) => i.status === 'regressed' && !i.outside && !EXPLAINED.has(i.group)).length;
    if (worse) warnings.push({ id: 'worse', text: `${worse} ${worse === 1 ? 'check got' : 'checks got'} worse than the original. See "Got worse" in Results.` });
  }
  const waiting = formCounts(report.asIs?.formRoutes ?? []).waiting;
  if (waiting && !report.copy?.formEndpoint) {
    warnings.push({ id: 'forms', text: `${waiting === 1 ? 'One form sends' : `${waiting} forms send`} nothing yet: on the live site, what visitors type there will not reach you until a form service is connected.` });
  }
  return { ok: blockers.length === 0, blockers, warnings };
}

/** The warnings not in `accepted` (ids the person confirmed). */
export const unaccepted = (warnings, accepted) => {
  const ok = new Set(Array.isArray(accepted) ? accepted.map(String) : []);
  return warnings.filter((w) => !ok.has(w.id));
};
