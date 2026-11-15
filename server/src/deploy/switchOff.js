// @ts-check
// "Can I switch off the old server?" (Go live): whether this website still needs the server it was copied from, item by item,
// from what Remastly knows of it. A `needs` item means switching the old server off now breaks something visitors use; an
// `advice` item is something only the owner can know (old entries kept somewhere); `ok` is done.
//
// It is about this website only: one old server often runs several websites, so the answer says to check each of them before
// the server itself is switched off.

/**
 * @param {{
 *   live: { url: string | null } | null,
 *   domain: { domain: string | null, connected?: boolean } | null,
 *   domainError?: string | null,
 *   report: any,
 *   passThrough: { target: string, paths: string[] } | null,
 *   appCalls: string[],
 *   snapshot?: { takenAt: string, count: number } | null,
 *   formsWaiting: number,
 *   formsSaved: boolean,
 *   imported: number,
 * }} o
 * @returns {{ safe: boolean, items: { id: string, status: 'ok' | 'needs' | 'advice', text: string }[] }}
 */
export function switchOffCheck({ live, domain, domainError = null, report, passThrough, appCalls, snapshot = null, formsWaiting, formsSaved, imported }) {
  /** @type {{ id: string, status: 'ok' | 'needs' | 'advice', text: string }[]} */
  const items = [];
  const add = (id, status, text) => items.push({ id, status, text });

  // Without a live copy, the old site is the only one.
  if (!live) add('live', 'needs', 'The copy is not online yet: the old site is still the only one. Put the copy online first.');
  else add('live', 'ok', `The copy is online at ${live.url}.`);

  // While the domain does not point to the copy, every visitor still goes to the old server (asked only once it is online).
  if (live) {
    // The host could not be asked (its account is no longer connected): unknown, so not taken as done.
    if (domainError) add('domain', 'needs', `Whether the domain points to the copy could not be checked: ${domainError}`);
    else if (!domain?.domain) add('domain', 'needs', 'The site\'s own domain is not connected to the copy, so visitors still reach the old server. Connect it under "Your own domain".');
    else if (!domain.connected) add('domain', 'needs', `${domain.domain} does not point to the copy yet (its DNS records are not in place), so visitors still reach the old server.`);
    else add('domain', 'ok', `${domain.domain} points to the copy.`);
  }

  // Files the copy still loads from the original's address stop loading once it is gone.
  const original = report?.safety?.original ?? [];
  if (original.length) add('files', 'needs', `The copy still loads ${original.length === 1 ? 'a file' : `${original.length} files`} from the old site (for example ${original[0]}). Make the copy again.`);
  else add('files', 'ok', 'The copy loads nothing from the old site.');

  // A login, a dashboard or data calls: answered by the old app (passed through) or by nobody.
  if (passThrough?.paths.length) {
    add('app', 'needs', `${passThrough.paths.join(', ')} ${passThrough.paths.length === 1 ? 'is' : 'are'} still passed to the old app at ${passThrough.target}. That app (and its database) must keep running, or move somewhere else first.`);
  } else if (appCalls.length) {
    add('app', 'needs', `The copy asks for ${appCalls.slice(0, 3).join(', ')}${appCalls.length > 3 ? ' and more' : ''}, which only the old app answers. Save their content under "Content from the old server", or keep the old app running for ${appCalls.length === 1 ? 'it' : 'them'}.`);
  } else add('app', 'ok', 'Nothing of the copy needs the old app (no login or data calls are left unanswered).');
  // Content from a snapshot is a picture of one moment: worth saying when it was taken.
  if (snapshot?.count) add('snapshot', 'ok', `${snapshot.count === 1 ? '1 address is' : `${snapshot.count} addresses are`} answered from the content snapshot of ${snapshot.takenAt.slice(0, 10)}; content added on the old site after that is not in it.`);

  // Forms that sent to the old server: saved by Remastly now, or sent nowhere.
  if (!formsWaiting) add('forms', 'ok', 'No form of the copy sent to the old server.');
  else if (formsSaved) add('forms', 'ok', `${formsWaiting === 1 ? 'Its form is' : `Its ${formsWaiting} forms are`} saved by Remastly (Form entries).`);
  else add('forms', 'needs', `${formsWaiting === 1 ? 'One form sends' : `${formsWaiting} forms send`} nothing once the old server is gone. Turn on "Save this site's form entries in Remastly" and update the live site.`);

  // Entries the old site kept: only the owner knows whether there are any.
  if (formsWaiting) {
    if (imported) add('entries', 'ok', `${imported === 1 ? '1 old entry was' : `${imported} old entries were`} imported.`);
    else add('entries', 'advice', 'If the old site kept form entries (in its database, Webflow or Framer), export them as CSV and import them under "Form entries" before switching it off.');
  }

  return { safe: !items.some((i) => i.status === 'needs'), items };
}
