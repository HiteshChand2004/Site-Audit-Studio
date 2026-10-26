import { FileText, Link2, Wrench } from 'lucide-react';
import { Card } from '../common/Surface.jsx';
import { plural } from '../../format.js';

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
    <Card icon={FileText} title="Every page" sub={`${plural(pages.length, 'page')} in ${copy.stack}.`}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>Page</th>
              <th scope="col" style={{ textAlign: 'left' }}>How it was made</th>
              <th scope="col">Controls</th>
              <th scope="col">Hovers</th>
              <th scope="col">Console errors</th>
              <th scope="col" style={{ textAlign: 'left' }}>Open</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => {
              const mine = open.filter((o) => o.page === p.path);
              return (
                <tr key={p.path}>
                  <td className="mono">{p.path}</td>
                  <td>As it is</td>
                  <td style={{ textAlign: 'center' }}>{p.controls ? `${p.controls.same} of ${p.controls.total}` : '–'}</td>
                  <td style={{ textAlign: 'center' }}>{p.hovers ? `${p.hovers.matched} of ${p.hovers.total}` : '–'}</td>
                  <td style={{ textAlign: 'center' }}>{p.console}</td>
                  <td>{mine.length ? mine.map((o) => `${o.check} (${o.values})`).join('; ') : 'Nothing open'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {fixes && (fixes.total > 0 || fixes.reverted.length > 0) && (
        <>
          <h3 style={{ marginTop: 16, display: 'flex', gap: 6, alignItems: 'center' }}><Wrench size={16} aria-hidden /> Fixed in the copy</h3>
          <p>Only fixes that change nothing a visitor sees were kept; each page was compared with itself before them.</p>
          <ul>
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
          <h3 style={{ marginTop: 16, display: 'flex', gap: 6, alignItems: 'center' }}><Link2 size={16} aria-hidden /> Links</h3>
          <ul>
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
