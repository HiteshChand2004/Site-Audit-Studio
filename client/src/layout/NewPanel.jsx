import { Download, Info, Sparkles } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import Badge from '../components/common/Badge.jsx';
import PreviewFrame from '../components/preview/PreviewFrame.jsx';
import FixChecklist from '../components/recreate/FixChecklist.jsx';
import { stackById } from '../constants.js';
import styles from './Panel.module.css';
import own from './NewPanel.module.css';

export default function NewPanel({ project, audit }) {
  const stack = stackById(project.stack);

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
        <PreviewFrame address="localhost:51xx · not started" tone="new">
          <div className={own.empty}>
            <Sparkles size={18} aria-hidden="true" />
            <p className={own.emptyTitle}>Abhi koi recreated version nahi</p>
            <p className={own.emptyText}>
              OLD panel me “Recreate” chalane ke baad naya site yahan live preview hoga.
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
              Sample checklist — real ✓/✗ Recreate ke baad re-audit se aayega.
            </p>
            <FixChecklist items={audit.recreate.checklist} />
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <Button icon={Download} disabled title="Phase 6 me available hoga">
          Download .zip
        </Button>
        <span className={styles.footerNote}>Preview production build par chalega.</span>
      </footer>
    </section>
  );
}
