import { AlertTriangle, CheckCircle2, Download, Info, Sparkles } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import Badge from '../components/common/Badge.jsx';
import PreviewFrame from '../components/preview/PreviewFrame.jsx';
import FixChecklist from '../components/recreate/FixChecklist.jsx';
import AnalyzeProgress from '../components/audit/AnalyzeProgress.jsx';
import { stackById } from '../constants.js';
import { useProjects } from '../store/useProjects.js';
import styles from './Panel.module.css';
import own from './NewPanel.module.css';

const STALE_DAYS = 7;

function ageDays(iso) {
  return iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 0;
}

export default function NewPanel({ project, audit }) {
  const stack = stackById(project.stack);
  const job = useProjects((s) => s.recreates[project.id]);
  const dismissJob = useProjects((s) => s.dismissJob);
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const result = latest?.result;
  const staleDays = audit && !audit.isDummy ? ageDays(audit.analyzedAt) : 0;

  return (
    <section className={`${styles.panel} ${styles.new}`} aria-label="Recreated website">
      <header className={styles.header}>
        <span className={styles.chip}>NEW</span>
        <span className={styles.headerSub}>Recreated site</span>
        <span className={styles.headerRight}>
          <Badge tone="accent">{stack.name}</Badge>
        </span>
      </header>

      <div className={`${styles.body} scroll`}>
        {staleDays > STALE_DAYS && (
          <p className={own.warn} role="status">
            <AlertTriangle size={13} aria-hidden="true" />
            The latest analysis is {Math.floor(staleDays)} days old. Run Analyze again before recreating if the site
            has changed.
          </p>
        )}

        {job && job.status !== 'done' && (
          <AnalyzeProgress analysis={job} kind="recreate" onDismiss={() => dismissJob('recreate', project.id)} />
        )}

        {result && (
          <p className={styles.dummyNote}>
            <CheckCircle2 size={13} aria-hidden="true" />
            Last recreated {new Date(result.createdAt).toLocaleString()} · {result.pages.length}{' '}
            {result.pages.length === 1 ? 'page' : 'pages'} · base URL <span className="mono">{result.baseUrl}</span>
          </p>
        )}

        <PreviewFrame address="localhost:51xx · not started" tone="new">
          <div className={own.empty}>
            <Sparkles size={18} aria-hidden="true" />
            <p className={own.emptyTitle}>No recreated version yet</p>
            <p className={own.emptyText}>
              Run “Recreate” from the OLD panel and a live preview of the new site will appear here.
            </p>
          </div>
        </PreviewFrame>

        {audit && (
          <>
            <div className={styles.sectionTitle}>
              <span>What gets fixed</span>
            </div>
            <p className={styles.dummyNote}>
              <Info size={13} aria-hidden="true" />
              Sample checklist — real ✓/✗ results come from re-auditing after Recreate.
            </p>
            <FixChecklist items={audit.recreate.checklist} />
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <Button icon={Download} disabled title="Available in Phase 6">
          Download .zip
        </Button>
        <span className={styles.footerNote}>Preview runs on the production build.</span>
      </footer>
    </section>
  );
}
