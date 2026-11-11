import { FileText, Link2, Wrench } from 'lucide-react';
import { Card } from '../common/Surface.jsx';
import { plural } from '../../format.js';
import styles from './CopyPages.module.css';

// Plain words for the link decisions of the link pass (server/src/copy/linkPass.js).
const LINK_ACTION = {
  ok: 'Works, left as it is',
  'redirect-final': 'Redirects: now points to its final address',
  'retarget-page': 'Wrong address: now points to the copy’s page',
  'https-upgrade': 'Works on https: now uses https',
  'copy-404': 'Gone on the original: now points to the copy’s 404 page',
  'flag-external': 'Dead external link: left as it is, suggested fix shown',
  'flag-internal': 'Could not confirm it is missing: left as it is',
  unverified: 'Could not verify: left as it is',
};

// Plain words for the kinds of safe fixes made in the copy's own markup (server/src/copy/fixAsIs.js).
const FIX_KIND = {
  alt: 'image descriptions',
  names: 'names for links, buttons and fields',
  aria: 'accessibility attributes',
  head: 'titles, descriptions and link previews',
  address: 'addresses moved to the new site',
  lang: 'page language',
  data: 'structured data for search and AI answers',
};

// How one check reads in the table: a score (visual), a count (controls, hovers), or nothing measured.
const cell = (v) => (v == null ? '–' : typeof v === 'number' ? String(Math.round(v)) : v);
// A look score below the original's (100) is marked, so the pages worth a look stand out.
const score = (v) => <span className={typeof v === 'number' && v < 100 ? styles.lower : undefined}>{cell(v)}</span>;

/**
 * The per-page results of "Copy my site": how each page was made, its checks, the open items, and what the link pass did.
 * @param {{ copy: object }} props  the copy's part of the recreate report (report.copy)
 */
export default function CopyPages({ copy }) {
  const pages = copy?.pages ?? [];
  const links = copy?.linkDecisions ?? [];
  const open = copy?.openItems ?? [];
  const fixes = copy?.fixes ?? null;
  if (!pages.length) return null;
  const linkWork = links.filter((l) => l.action !== 'ok');
  return (
    <Card icon={FileText} title="Every page" sub={`${plural(pages.length, 'page')} in ${copy.stack}. Scores: 100 is the same as the original.`}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Made</th>
              <th scope="col" className={styles.num}>Look, computer</th>
              <th scope="col" className={styles.num}>Look, phone</th>
              <th scope="col" className={styles.num}>Controls</th>
              <th scope="col" className={styles.num}>Hovers</th>
              <th scope="col" className={styles.num}>Console errors</th>
              <th scope="col">Still open</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => {
              const mine = open.filter((o) => o.page === p.path);
              return (
                <tr key={p.path}>
                  <td className={`mono ${styles.path}`}>{p.path}</td>
                  <td className={styles.path}>As it is</td>
                  <td className={styles.num}>{score(p.visual?.[1440])}</td>
                  <td className={styles.num}>{score(p.visual?.[390])}</td>
                  <td className={styles.num}>{p.controls ? `${p.controls.same} of ${p.controls.total}` : '–'}</td>
                  <td className={styles.num}>{p.hovers ? `${p.hovers.matched} of ${p.hovers.total}` : '–'}</td>
                  <td className={styles.num}>{p.console}</td>
                  <td className={styles.open}>
                    {mine.length ? mine.map((o, i) => (
                      <div key={i} className={styles.openItem}>
                        <strong>{o.check.charAt(0).toUpperCase() + o.check.slice(1)}</strong>
                        {o.values && <span className={styles.openDetail}>{o.values}</span>}
                      </div>
                    )) : <span className={styles.none}>Nothing</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {fixes && (fixes.total > 0 || fixes.reverted.length > 0) && (
        <>
          <h3 className={styles.h}><Wrench size={16} aria-hidden /> Fixed in the copy</h3>
          <p className={styles.lead}>Only fixes that change nothing a visitor sees were kept; each page was compared with itself before them.</p>
          <ul className={styles.list}>
            {Object.entries(fixes.counts ?? {}).map(([kind, n]) => (
              <li key={kind}>{n} × {FIX_KIND[kind] ?? kind}</li>
            ))}
            {fixes.files?.length > 0 && <li>Site files served by the copy: <span className="mono">{fixes.files.join(', ')}</span></li>}
            {fixes.headers?.applied?.length > 0 && <li>Security headers sent by the copy’s own server: {fixes.headers.applied.join(', ')}</li>}
            {fixes.headers?.takeEffect === 'host' && <li>Security headers: prepared for hosts that read <span className="mono">_headers</span> (Netlify, Cloudflare Pages); not counted until the copy is hosted</li>}
            {fixes.reverted.map((r) => (
              <li key={r.page}>
                <span className="mono">{r.page}</span>: fixes undone, because {r.why}
              </li>
            ))}
          </ul>
        </>
      )}

      {linkWork.length > 0 && (
        <>
          <h3 className={styles.h}><Link2 size={16} aria-hidden /> Links</h3>
          <ul className={styles.list}>
            {linkWork.map((l) => (
              <li key={l.href}>
                <span className="mono">{l.href}</span>: {LINK_ACTION[l.action] ?? l.action}
                {l.url && <> → <span className="mono">{l.url}</span></>}
                {l.suggestion && <> (suggested: <span className="mono">{l.suggestion}</span>)</>}
              </li>
            ))}
          </ul>
        </>
      )}
      {copy?.linkError && <p>The links could not be re-checked in a browser: {copy.linkError}</p>}
    </Card>
  );
}
