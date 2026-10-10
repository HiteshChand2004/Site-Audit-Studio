// What is still different between the original and the copy, element by element, kept across the rounds of the
// correction loop.
//
// The measurements already existed: compareLayout counted how many boxes matched and planFixes decided a width or a
// min-height from the same numbers - and then both threw the pairs away, so the report could say "195 elements did
// not render" without being able to name one of them. The ledger keeps them, which is what makes a second round
// smarter than the first and what lets anything left over be reported with a cause instead of disappearing.
//
// Entries are keyed by `cpath` (the element's path in the desktop capture), never by `sid`: numberNodes() hands out
// new sids every time the IR is rebuilt, so a sid is only valid within one measurement build. `resolve(site)` walks
// the trees again and re-attaches the live node and its current sid. An element the capture never saw on the desktop
// view has no cpath and cannot be tracked between rounds; it is counted in `skipped.noKey` rather than guessed at.
const round3 = (n) => Math.round(n * 1000) / 1000;

const keyOf = (page, view, cpath) => `${page}|${view}|${cpath}`;

/** @returns {object} an empty ledger. Put it on `site.ledger` so rebuilding the IR cannot lose it. */
export function createLedger() {
  /** @type {Map<string, object>} */
  const entries = new Map();
  const skipped = { noKey: 0 };
  // The round the measurements being recorded belong to, so the summary can tell a mismatch that is still there from
  // one that went away: an entry last seen in an earlier round is no longer a mismatch.
  let round = 0;

  const entry = (page, view, cpath) => {
    const key = keyOf(page, view, cpath);
    let e = entries.get(key);
    if (!e) {
      e = {
        key, page, view, cpath,
        sid: null, node: null,
        kind: null, cause: null,
        expected: null, actual: null, region: null,
        blame: 0, iou: 0,
        rounds: [],
        lastSeen: -1,
        tried: new Set(),
        frozen: false,
      };
      entries.set(key, e);
    }
    return e;
  };

  return {
    entries,
    skipped,

    /** Start recording a round's measurements. */
    beginRound(n) {
      round = n;
    },
    get round() {
      return round;
    },

    /**
     * Record one view's geometry mismatches, as handed out by compareLayout(root, view, rects, { pairs: true }).
     * @param {{ page: string, view: string, rows: object[] }} o
     */
    observe({ page, view, rows }) {
      for (const row of rows ?? []) {
        if (!row.cpath) { skipped.noKey++; continue; }
        const e = entry(page, view, row.cpath);
        e.sid = row.sid;
        e.kind = row.kind;
        e.tag = row.tag;
        e.expected = row.expected;
        e.actual = row.actual;
        e.iou = row.iou;
        e.lastSeen = round;
        e.rounds.push({ round, kind: row.kind, iou: row.iou, widthOk: row.widthOk, heightOk: row.heightOk });
      }
    },

    /**
     * Record the elements a visual-diff region blames. Only a `coarse` region may do this: a region that differs at
     * the detail scale alone is thin structure (text anti-aliasing, a font rendered a shade differently) and must
     * never drive a correction.
     * @param {{ page: string, view: string, region: object, candidates: object[] }} o
     */
    observePixels({ page, view, region, candidates }) {
      if (!region?.coarse) return;
      for (const c of candidates ?? []) {
        if (!c.cpath) { skipped.noKey++; continue; }
        const e = entry(page, view, c.cpath);
        e.sid = c.sid;
        e.node = c.node;
        e.tag ??= c.tag;
        e.kind ??= 'pixel';
        e.expected ??= c.expected;
        e.lastSeen = round;
        if (e.actual == null) e.actual = c.actual;
        if (c.blame > e.blame) {
          e.blame = c.blame;
          e.region = { fx: region.fx, fy: region.fy, fw: region.fw, fh: region.fh, score: region.score, coarse: true, onlyOne: !!region.onlyOne };
        }
        e.rounds.push({ round, kind: 'pixel', blame: c.blame, regionScore: region.score });
      }
    },

    /**
     * Re-attach the live node and its current sid after the IR was rebuilt (numberNodes hands out new sids).
     * Entries whose element no longer exists in the tree are dropped. `site.pages[i]` carries `.root` and
     * `.info.path`, the same path the pages are recorded under.
     */
    resolve(site) {
      const byPage = new Map();
      for (const tree of site.pages ?? []) {
        const map = new Map();
        const walk = (n) => {
          if (!n || 'text' in n) return;
          if (n.cpath) map.set(n.cpath, n);
          for (const alt of n.cpathAlt ?? []) if (!map.has(alt)) map.set(alt, n);
          if (n.tag !== 'svg') for (const c of n.children ?? []) walk(c);
        };
        walk(tree.root);
        byPage.set(tree.info?.path, map);
      }
      for (const [key, e] of entries) {
        const node = byPage.get(e.page)?.get(e.cpath);
        if (!node) { entries.delete(key); continue; }
        e.node = node;
        e.sid = node.sid ?? null;
      }
      return entries;
    },

    /** Has this corrector already offered this property on this element? Nothing is ever tried twice. */
    wasTried(e, corrector, prop) {
      return e.tried.has(`${corrector}:${prop}`);
    },
    markTried(e, corrector, prop) {
      e.tried.add(`${corrector}:${prop}`);
    },
    /** After a rolled-back round: never touch these elements again in this job. */
    freeze(list) {
      for (const e of list) e.frozen = true;
    },

    /**
     * The part that belongs in report.json: counts, plus the worst entries by name. Bounded on purpose - the map
     * itself can hold thousands of elements, and a report is not a place for all of them.
     * `open` = still a mismatch in the last round recorded; `cleared` = seen earlier but not any more.
     */
    summary({ worst = 10 } = {}) {
      const byKind = {};
      const byCause = {};
      let open = 0;
      let cleared = 0;
      for (const e of entries.values()) {
        const still = e.lastSeen === round;
        if (still) {
          open++;
          byKind[e.kind ?? 'unknown'] = (byKind[e.kind ?? 'unknown'] ?? 0) + 1;
        } else cleared++;
        if (e.cause) byCause[e.cause] = (byCause[e.cause] ?? 0) + 1;
      }
      const rank = (e) => (e.lastSeen === round ? 10 : 0) + (e.kind === 'missing' ? 1 : 0) + e.blame + (1 - (e.iou ?? 0));
      const top = [...entries.values()].sort((a, b) => rank(b) - rank(a)).slice(0, worst).map((e) => ({
        page: e.page, view: e.view, cpath: e.cpath, tag: e.tag, kind: e.kind,
        cause: e.cause, iou: e.iou, blame: round3(e.blame), frozen: e.frozen, open: e.lastSeen === round,
        ...(e.expected && { expected: e.expected }),
        ...(e.actual && { actual: e.actual }),
      }));
      return { elements: entries.size, open, cleared, rounds: round, byKind, byCause, skipped: { ...skipped }, worst: top };
    },
  };
}
