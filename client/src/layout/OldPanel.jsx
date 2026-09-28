import { useEffect, useState } from 'react';
import { AlertTriangle, Globe, Info, Loader2, Play, Settings2, Sparkles, ShieldAlert } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import Badge from '../components/common/Badge.jsx';
import PreviewFrame, { Wireframe } from '../components/preview/PreviewFrame.jsx';
import MetricsBar from '../components/audit/MetricsBar.jsx';
import AuditReport from '../components/audit/AuditReport.jsx';
import AnalyzeProgress from '../components/audit/AnalyzeProgress.jsx';
import { stackById } from '../constants.js';
import { isAnalysisActive, useProjects } from '../store/useProjects.js';
import styles from './Panel.module.css';

const Spinner = (props) => <Loader2 {...props} className={styles.spin} />;

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function OldPanel({ project, audit, loading, onOpenStack }) {
  const [url, setUrl] = useState(project.url);
  const [maxPages, setMaxPages] = useState(String(project.max_pages ?? 25));
  useEffect(() => setUrl(project.url), [project.url]);
  useEffect(() => setMaxPages(String(project.max_pages ?? 25)), [project.max_pages]);

  const analysis = useProjects((s) => s.analyses[project.id]);
  const analyze = useProjects((s) => s.analyze);
  const update = useProjects((s) => s.update);
  const dismissAnalysis = useProjects((s) => s.dismissAnalysis);
  const running = isAnalysisActive(analysis);

  const saveMaxPages = () => {
    const n = Number(maxPages);
    if (Number.isInteger(n) && n >= 1 && n <= 100) {
      if (n !== project.max_pages) update(project.id, { max_pages: n }).catch(() => {});
    } else {
      setMaxPages(String(project.max_pages ?? 25));
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!running) analyze(project.id, url);
  };

  return (
    <section className={`${styles.panel} ${styles.old}`} aria-label="Original website">
      <header className={styles.header}>
        <span className={styles.chip}>OLD</span>
        <span className={styles.headerSub}>Original site</span>
        <span className={styles.headerRight}>
          {audit?.isDummy && <Badge tone="warn">Dummy data</Badge>}
        </span>
      </header>

      <div className={`${styles.body} scroll`}>
        <form className={styles.urlRow} onSubmit={onSubmit}>
          <label className={styles.urlInput}>
            <Globe size={14} aria-hidden="true" />
            <input
              className="mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Website URL"
              disabled={running}
            />
          </label>
          <label className={styles.pagesInput} title="Maximum pages to crawl (1–100)">
            <span>Pages</span>
            <input
              className="mono"
              type="number"
              min={1}
              max={100}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
              onBlur={saveMaxPages}
              aria-label="Maximum pages to crawl"
              disabled={running}
            />
          </label>
          <Button type="submit" variant={audit?.isDummy ? 'primary' : 'secondary'} icon={running ? Spinner : Play} disabled={running}>
            {running ? 'Analyzing…' : 'Analyze'}
          </Button>
        </form>

        {analysis && analysis.status !== 'done' && (
          <AnalyzeProgress analysis={analysis} onDismiss={() => dismissAnalysis(project.id)} />
        )}

        <PreviewFrame
          address={project.url}
          tone="old"
          overlay={
            audit && !audit.frame.frameable ? (
              <>
                <ShieldAlert size={13} color="var(--warn)" aria-hidden="true" />
                <span>
                  Iframe blocked · <span className="mono">{audit.frame.reason}</span>
                </span>
              </>
            ) : null
          }
        >
          <Wireframe />
        </PreviewFrame>

        {loading && <p className={styles.dummyNote}>Loading audit…</p>}

        {audit && (
          <>
            <div className={styles.sectionTitle}>
              <span>Performance</span>
              {!audit.isDummy && audit.metrics?.device && <span className={styles.sectionMeta}>Lighthouse · homepage</span>}
            </div>
            <MetricsBar metrics={audit.metrics} scores={audit.scores} />

            <div className={styles.sectionTitle}>
              <span>Audit report</span>
              {!audit.isDummy && (
                <span className={styles.sectionMeta}>
                  Analyzed {timeAgo(audit.analyzedAt)} · {audit.pagesCrawled} {audit.pagesCrawled === 1 ? 'page' : 'pages'}
                </span>
              )}
            </div>
            {audit.isDummy && (
              <p className={styles.dummyNote}>
                <Info size={13} aria-hidden="true" />
                Sample report — click “Analyze” to run the real audit.
              </p>
            )}
            {audit.errors?.length > 0 && (
              <div className={styles.stepErrors} role="status">
                <AlertTriangle size={13} aria-hidden="true" />
                <div>
                  <strong>Some checks did not complete; the report is partial.</strong>
                  <ul>
                    {audit.errors.map((e, i) => (
                      <li key={i}>
                        <span className="mono">{e.step}</span> — {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <AuditReport audit={audit} />
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <Button variant="primary" icon={Sparkles} disabled title="Available in Phase 4">
          Recreate
        </Button>
        <Button icon={Settings2} iconOnly onClick={onOpenStack} title="Output stack settings">
          Output stack settings
        </Button>
        <span className={styles.footerNote}>
          Output: <strong>{stackById(project.stack).name}</strong>
        </span>
      </footer>
    </section>
  );
}
