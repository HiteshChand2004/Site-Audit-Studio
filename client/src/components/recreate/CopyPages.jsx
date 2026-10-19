import { FileText, Link2 } from 'lucide-react';
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

// How one check reads in the table: a score (visual), a count (controls, hovers), or nothing measured.
const cell = (v) => (v == null ? '–' : typeof v === 'number' ? String(Math.round(v)) : v);

/**
 * The per-page results of "Copy my site": how each page was made, its checks, the open items, and what the link pass did.
 * @param {{ copy: object }} props  the copy's part of the recreate report (report.copy)
 */
export default function CopyPages({ copy }) {
  const pages = copy?.pages ?? [];
  const links = copy?.linkDecisions ?? [];
  const open = copy?.openItems ?? [];
  if (!pages.length) return null;
  const linkWork = links.filter((l) => l.action !== 'ok');
  return (
    <Card icon={FileText} title="Every page" sub={`${plural(pages.length, 'page')} in ${copy.stack}. Scores: 100 is the same as the original.`}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>Page</th>
              <th scope="col" style={{ textAlign: 'left' }}>How it was made</th>
              <th scope="col">Look, computer</th>
              <th scope="col">Look, phone</th>
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
                  <td style={{ textAlign: 'center' }}>{cell(p.visual?.[1440])}</td>
                  <td style={{ textAlign: 'center' }}>{cell(p.visual?.[390])}</td>
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
