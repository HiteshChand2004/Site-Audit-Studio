import {
  Accessibility,
  AlertTriangle,
  Bot,
  Check,
  Cpu,
  FileCode2,
  Link2Off,
  Minus,
  Search,
  Wrench,
  X,
} from 'lucide-react';
import SectionCard from '../common/SectionCard.jsx';
import Badge from '../common/Badge.jsx';
import styles from './AuditReport.module.css';

const STATUS_ICON = { pass: Check, warn: Minus, fail: X };
const STATUS_TONE = { pass: 'ok', warn: 'warn', fail: 'bad' };
const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: 'info' };
const IMPACT_TONE = { critical: 'bad', serious: 'bad', moderate: 'warn', minor: 'info' };

function countBy(items, key) {
  return items.reduce((acc, it) => ({ ...acc, [it[key]]: (acc[it[key]] || 0) + 1 }), {});
}

function StatusCounts({ items }) {
  const c = countBy(items, 'status');
  return (
    <>
      {c.fail > 0 && <Badge tone="bad">{c.fail} fail</Badge>}
      {c.warn > 0 && <Badge tone="warn">{c.warn} warn</Badge>}
      {c.pass > 0 && <Badge tone="ok">{c.pass} pass</Badge>}
    </>
  );
}

function CheckRows({ items }) {
  return (
    <ul className={styles.rows}>
      {items.map((it) => {
        const Icon = STATUS_ICON[it.status];
        return (
          <li key={it.title} className={styles.row}>
            <span className={styles.status} data-tone={STATUS_TONE[it.status]} aria-label={it.status}>
              <Icon size={11} strokeWidth={3} />
            </span>
            <span className={styles.rowTitle}>{it.title}</span>
            <span className={styles.rowDetail}>{it.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ children }) {
  return <p className={styles.empty}>{children}</p>;
}

function confidenceLevel(c) {
  if (c == null) return ['No match', 'neutral'];
  if (c >= 80) return ['High', 'ok'];
  if (c >= 40) return ['Medium', 'warn'];
  return ['Low', 'bad'];
}

export default function AuditReport({ audit }) {
  const crawlItems = [
    { title: 'sitemap.xml', ...audit.crawl.sitemap },
    { title: 'robots.txt', ...audit.crawl.robots },
    { title: 'Meta tags', ...audit.crawl.metaTags },
  ];
  const primary = audit.techStack[0];
  const unverified = audit.brokenLinks.unverified ?? [];
  const a11yFailed = audit.errors?.some((e) => e.step === 'render');

  return (
    <div className={styles.report}>
      <SectionCard
        icon={Cpu}
        title="Tech stack"
        meta={primary && <Badge tone="accent">{primary.name}</Badge>}
      >
        <ul className={styles.stack}>
          {audit.techStack.map((t) => {
            const [level, tone] = confidenceLevel(t.confidence);
            return (
              <li key={t.id} className={styles.stackItem}>
                <div className={styles.stackHead}>
                  <span className={styles.stackName}>{t.name}</span>
                  <Badge tone={tone} dot>
                    {level}
                    {t.confidence != null && (
                      <>
                        {' · '}
                        <span className="mono">{t.confidence}%</span>
                      </>
                    )}
                  </Badge>
                </div>
                {t.confidence != null && (
                  <div className={styles.meter} data-tone={tone}>
                    <span style={{ width: `${t.confidence}%` }} />
                  </div>
                )}
                <ul className={styles.evidence}>
                  {t.evidence.map((e) => (
                    <li key={e} className="mono">
                      {e}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard
        icon={AlertTriangle}
        title="Weaknesses & platform limits"
        meta={<Badge>{audit.weaknesses.length}</Badge>}
      >
        {audit.weaknesses.length === 0 && <Empty>No platform limits or measured performance problems found.</Empty>}
        <ul className={styles.rows}>
          {audit.weaknesses.map((w) => (
            <li key={w.title} className={styles.row}>
              <Badge tone={SEVERITY_TONE[w.severity]} className={styles.sev}>
                {w.severity}
              </Badge>
              <span className={styles.rowTitle}>{w.title}</span>
              <span className={styles.rowDetail}>{w.detail}</span>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard icon={Search} title="SEO" meta={<StatusCounts items={audit.seo} />}>
        <CheckRows items={audit.seo} />
      </SectionCard>

      <SectionCard icon={Bot} title="AEO · answer engines" meta={<StatusCounts items={audit.aeo} />}>
        <CheckRows items={audit.aeo} />
      </SectionCard>

      <SectionCard icon={FileCode2} title="Meta, sitemap & robots" meta={<StatusCounts items={crawlItems} />}>
        <CheckRows items={crawlItems} />
      </SectionCard>

      <SectionCard
        icon={Link2Off}
        title="Broken links"
        meta={
          <Badge tone={audit.brokenLinks.broken.length ? 'bad' : 'ok'}>
            {audit.brokenLinks.broken.length} / {audit.brokenLinks.checked}
          </Badge>
        }
        defaultOpen={false}
      >
        {audit.brokenLinks.broken.length === 0 && <Empty>No broken links found.</Empty>}
        {audit.brokenLinks.total > audit.brokenLinks.checked && (
          <p className={styles.hint}>
            Checked the first {audit.brokenLinks.checked} of {audit.brokenLinks.total} unique links.
          </p>
        )}
        {audit.brokenLinks.broken.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th>Found on</th>
            </tr>
          </thead>
          <tbody>
            {audit.brokenLinks.broken.map((l) => (
              <tr key={l.url}>
                <td className="mono">{l.url.replace(/^https?:\/\//, '')}</td>
                <td>
                  <Badge tone="bad" mono>
                    {l.status}
                  </Badge>
                </td>
                <td className="mono">{l.foundOn}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
        {unverified.length > 0 && (
          <>
            <p className={styles.hint}>
              Unverified — these servers refused or timed out on the automated check. Open them manually.
            </p>
            <table className={styles.table}>
              <tbody>
                {unverified.map((l) => (
                  <tr key={l.url}>
                    <td className="mono">{l.url.replace(/^https?:\/\//, '')}</td>
                    <td>
                      <Badge tone="warn" mono>
                        {l.status}
                      </Badge>
                    </td>
                    <td>{l.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </SectionCard>

      <SectionCard
        icon={Accessibility}
        title="Accessibility"
        meta={<Badge>{audit.accessibility.reduce((n, a) => n + a.count, 0)} issues</Badge>}
        defaultOpen={false}
      >
        {audit.accessibility.length === 0 && (
          <Empty>{a11yFailed ? 'The accessibility scan did not run.' : 'No axe-core violations found on the homepage.'}</Empty>
        )}
        <ul className={styles.rows}>
          {audit.accessibility.map((a) => (
            <li key={a.id ?? a.title} className={styles.row}>
              <Badge tone={IMPACT_TONE[a.impact]} className={styles.sev}>
                {a.impact}
              </Badge>
              <span className={styles.rowTitle}>
                {a.helpUrl ? (
                  <a href={a.helpUrl} target="_blank" rel="noreferrer">
                    {a.title}
                  </a>
                ) : (
                  a.title
                )}
              </span>
              <span className={`${styles.rowDetail} mono`}>×{a.count}</span>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard icon={Wrench} title="Manual rebuild needed" meta={<Badge tone="warn">{audit.manualRebuild.length}</Badge>}>
        {audit.manualRebuild.length === 0 ? (
          <Empty>Nothing detected that needs a manual rebuild.</Empty>
        ) : (
          <p className={styles.note}>
            This functionality can’t be recreated automatically and must be rebuilt manually.
          </p>
        )}
        <ul className={styles.rows}>
          {audit.manualRebuild.map((m) => (
            <li key={m.title} className={styles.row}>
              <Badge className={styles.sev}>{m.kind}</Badge>
              <span className={styles.rowTitle}>{m.title}</span>
              <span className={styles.rowDetail}>{m.detail}</span>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
