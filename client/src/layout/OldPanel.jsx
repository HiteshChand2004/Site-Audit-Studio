import { useEffect, useState } from 'react';
import { Globe, Info, Play, Settings2, Sparkles, ShieldAlert } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import Badge from '../components/common/Badge.jsx';
import PreviewFrame, { Wireframe } from '../components/preview/PreviewFrame.jsx';
import MetricsBar from '../components/audit/MetricsBar.jsx';
import AuditReport from '../components/audit/AuditReport.jsx';
import { stackById } from '../constants.js';
import styles from './Panel.module.css';

export default function OldPanel({ project, audit, loading, onOpenStack }) {
  const [url, setUrl] = useState(project.url);
  useEffect(() => setUrl(project.url), [project.url]);

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
        <form className={styles.urlRow} onSubmit={(e) => e.preventDefault()}>
          <label className={styles.urlInput}>
            <Globe size={14} aria-hidden="true" />
            <input
              className="mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Website URL"
            />
          </label>
          <Button type="submit" icon={Play} disabled title="Available in Phase 2">
            Analyze
          </Button>
        </form>

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
            </div>
            <MetricsBar metrics={audit.metrics} scores={audit.scores} />

            <div className={styles.sectionTitle}>
              <span>Audit report</span>
            </div>
            {audit.isDummy && (
              <p className={styles.dummyNote}>
                <Info size={13} aria-hidden="true" />
                Sample report — the real audit arrives in Phase 2 via “Analyze”.
              </p>
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
