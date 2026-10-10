// How many interactive things are on this page at all - counted before any probe decides what it has time for.
//
// Every probe already reports how much it did (`stats.candidates`, `probed`, `found`, `skipped`), but "candidates"
// is what was left after its own filters: a per-signature cap, a node cap, a hint match. So the existing numbers can
// say "40 of 40 probed" on a page with 300 buttons, which is true and useless. This is the denominator those numbers
// are missing, taken straight from the DOM with nothing left out, so a coverage report can say what share of a page's
// interactive parts the copy actually understands - and name the rest.
//
// Cheap on purpose: one walk, and the one expensive question (is this element's cursor a pointer?) asked only up to a
// cap, with the count of what was not asked reported rather than assumed.

/** Page function. Nothing here filters: that is the whole point. */
export function censusInteractive({ cursorCap = 4000 } = {}) {
  const byKind = {};
  const hidden = {};
  let total = 0;
  let visible = 0;
  const bump = (kind, isVisible) => {
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    total++;
    if (isVisible) visible++;
    else hidden[kind] = (hidden[kind] ?? 0) + 1;
  };

  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };

  // The kinds a visitor can act on, in the order a probe would consider them. An element counts once, under the
  // first kind that describes it, so the kinds add up to the total.
  const KINDS = [
    ['link', 'a[href]:not([href^="#"]):not([href^="javascript:"])'],
    ['anchor-link', 'a[href^="#"]'],
    ['button', 'button, input[type=button], input[type=submit], input[type=reset], [role=button]'],
    ['field', 'input:not([type=button]):not([type=submit]):not([type=reset]), textarea, select'],
    ['disclosure', '[aria-expanded], summary, details'],
    ['tab', '[role=tab], [role=tablist] > *'],
    ['menu', '[role=menu], [role=menuitem], [role=menubar]'],
    ['dialog', '[role=dialog], dialog, [aria-modal=true]'],
    ['switch', '[role=switch], [role=checkbox], [role=radio]'],
    ['combobox', '[role=combobox], [role=listbox], [role=option]'],
    ['labelled', 'label[for]'],
    ['focusable', '[tabindex]:not([tabindex="-1"])'],
    ['handler', '[onclick], [onmousedown], [onmouseover]'],
  ];

  const seen = new Set();
  for (const [kind, selector] of KINDS) {
    let found;
    try {
      found = document.querySelectorAll(selector);
    } catch {
      continue; // a selector this browser will not parse
    }
    for (const el of found) {
      if (seen.has(el)) continue;
      seen.add(el);
      bump(kind, shown(el));
    }
  }

  // Anything else the page has dressed as clickable. This is the expensive question, so it is capped and what was
  // left unasked is counted.
  let cursorChecked = 0;
  let cursorSkipped = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (seen.has(el)) continue;
    if (cursorChecked >= cursorCap) {
      cursorSkipped++;
      continue;
    }
    cursorChecked++;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      continue;
    }
    if (cs.cursor !== 'pointer') continue;
    // A child of something already counted is that thing's own area, not a control of its own.
    let inside = false;
    for (let p = el.parentElement; p; p = p.parentElement) if (seen.has(p)) { inside = true; break; }
    if (inside) continue;
    seen.add(el);
    bump('pointer', shown(el));
  }

  return { total, visible, byKind, hidden, cursorChecked, cursorSkipped };
}

/**
 * What the probes of one view managed, against what was there. Pure arithmetic over the numbers the capture already
 * records, so it invents nothing.
 * @param {object} census  censusInteractive()'s result for that view
 * @param {object} motion  that view's motion summary (capture/index.js)
 */
export function coverageOf(census, motion) {
  if (!census) return null;
  const clicks = motion?.clicks ?? {};
  const probed = (clicks.probed ?? 0) + (motion?.probed ?? 0);
  const understood = (clicks.found ?? 0) + (motion?.hover ?? 0) + (motion?.focus ?? 0);
  const skipped = clicks.skipped ?? {};
  // Why the probes did not reach the rest. Every reason is one the capture itself recorded.
  const reasons = {
    ...(skipped.limit && { 'budget reached': skipped.limit }),
    ...(skipped.duplicate && { 'the same kind of control, already probed': skipped.duplicate }),
    ...(skipped.hidden && { 'not shown at this size': skipped.hidden }),
    ...(skipped.inside && { 'inside another control': skipped.inside }),
    ...(clicks.timedOut && { 'the probe ran out of time': 1 }),
    ...(census.cursorSkipped && { 'not examined (page too large)': census.cursorSkipped }),
  };
  return {
    interactive: census.total,
    visible: census.visible,
    probed,
    understood,
    byKind: census.byKind,
    hidden: census.hidden,
    reasons,
    // The honest share: of the interactive parts a visitor can see, how many the probes actually examined.
    examined: census.visible ? Math.round((Math.min(probed, census.visible) / census.visible) * 100) : null,
  };
}
