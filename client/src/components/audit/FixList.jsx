import { CheckCircle2, ChevronRight, ListTodo, Wrench } from 'lucide-react';
import { Card } from '../common/Surface.jsx';
import { Pill } from '../common/Score.jsx';
import { CHECKS, SEVERITY } from '../../copy.js';
import { plural } from '../../format.js';
import styles from './FixList.module.css';

const RANK = { high: 0, medium: 1, low: 2 };
const IMPACT = { critical: 'high', serious: 'high', moderate: 'medium', minor: 'low' };

const plain = (title) => CHECKS[title] ?? { title, why: null, area: null };

/** Every problem the check found, as plain rows (most important first), and the checks that passed. */
export function problemsOf(audit) {
  const rows = [];
  const crawl = [
    { title: 'sitemap.xml', ...audit.crawl?.sitemap },
    { title: 'robots.txt', ...audit.crawl?.robots },
    { title: 'Meta tags', ...audit.crawl?.metaTags },
  ].filter((c) => c.status);
  const checks = [...(audit.seo ?? []), ...(audit.aeo ?? []), ...crawl];
  for (const c of checks) {
    if (c.status === 'pass') continue;
    const p = plain(c.title);
    rows.push({ id: `check-${c.title}`, severity: c.status === 'fail' ? 'high' : 'medium', ...p, detail: c.detail });
  }
  for (const w of audit.weaknesses ?? []) {
    const p = plain(w.title);
    rows.push({ id: `weak-${w.title}`, severity: w.severity ?? 'medium', ...p, area: p.area ?? 'Speed', detail: w.detail });
  }
  for (const a of audit.accessibility ?? []) {
    rows.push({
      id: `a11y-${a.id ?? a.title}`,
      severity: IMPACT[a.impact] ?? 'medium',
      title: a.title,
      why: 'Makes the page harder to use for people who rely on a screen reader, a keyboard or good contrast.',
      area: 'Easy for everyone',
      detail: `${plural(a.count ?? 1, 'place')} on the homepage.`,
      help: a.helpUrl,
    });
  }
  const broken = audit.brokenLinks?.broken ?? [];
  if (broken.length) {
    rows.push({
      id: 'broken-links',
      severity: 'high',
      title: `${plural(broken.length, 'link')} lead${broken.length === 1 ? 's' : ''} nowhere`,
      why: 'Visitors who click them get an error page, and Google sees a neglected site.',
      area: 'Found on Google',
      fix: true,
      links: broken,
      unverified: audit.brokenLinks.unverified?.length ?? 0,
    });
  }
  rows.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const passed = checks.filter((c) => c.status === 'pass').map((c) => ({ id: c.title, ...plain(c.title), detail: c.detail }));
  return { rows, passed };
}

function Row({ row }) {
  const sev = SEVERITY[row.severity] ?? SEVERITY.medium;
  return (
    <li>
      <details className={styles.row}>
        <summary>
          <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
          <Pill tone={sev.tone}>{sev.label}</Pill>
          <span className={styles.title}>{row.title}</span>
          {row.area && <span className={styles.area}>{row.area}</span>}
          {row.fix && <span className={styles.fix}>Usually fixed in the copy</span>}
        </summary>
        <div className={styles.body}>
          {row.why && (
            <p>
              <strong>Why it matters:</strong> {row.why}
            </p>
          )}
          {row.detail && <p className={styles.detail}>What the check found: {row.detail}</p>}
          {row.links && (
            <ul className={styles.links}>
              {row.links.slice(0, 20).map((l) => (
                <li key={l.url}>
                  <span className="mono">{l.url.replace(/^https?:\/\//, '')}</span>
                  <span className={styles.detail}>
                    {l.status ? `error ${l.status}` : 'no answer'}
                    {l.foundOn ? ` · on ${l.foundOn}` : ''}
                  </span>
                </li>
              ))}
              {row.links.length > 20 && <li className={styles.detail}>and {row.links.length - 20} more</li>}
            </ul>
          )}
          {row.unverified > 0 && (
            <p className={styles.detail}>
              {plural(row.unverified, 'more link')} could not be checked automatically (the other site refused or did not answer); open them yourself.
            </p>
          )}
          {row.help && (
            <p>
              <a href={row.help} target="_blank" rel="noreferrer">
                How to fix this
              </a>
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

/** "What needs fixing", "Already fine" and "Needs a person". */
export default function FixList({ audit }) {
  const { rows, passed } = problemsOf(audit);
  const manual = audit.manualRebuild ?? [];
  const important = rows.filter((r) => r.severity === 'high').length;
  return (
    <>
      <Card
        icon={ListTodo}
        title="What needs fixing"
        sub={rows.length ? `${plural(rows.length, 'problem')} found${important ? `, ${important} of them important` : ''}. Click a row to see why it matters.` : 'Nothing important was found.'}
        flush
      >
        {rows.length > 0 && (
          <ul className={styles.list}>
            {rows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </ul>
        )}
        {passed.length > 0 && (
          <details className={styles.passed}>
            <summary>
              <CheckCircle2 size={16} aria-hidden="true" />
              Already fine ({passed.length})
            </summary>
            <ul>
              {passed.map((p) => (
                <li key={p.id}>
                  <strong>{p.title}</strong>
                  {p.detail && <span className={styles.detail}> · {p.detail}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      {manual.length > 0 && (
        <Card icon={Wrench} title="Needs a person" sub="These parts work with a server or an outside service, so a copy cannot rebuild them honestly. They are listed, never faked.">
          <ul className={styles.manual}>
            {manual.map((m) => (
              <li key={m.title}>
                <span className={styles.title}>{m.title}</span>
                {m.detail && <span className={styles.detail}>{m.detail}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
