import { useEffect, useState } from 'react';
import { ArrowUpDown, Globe, Plus } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import OldPanel from './OldPanel.jsx';
import NewPanel from './NewPanel.jsx';
import Disclaimer from '../components/common/Disclaimer.jsx';
import Button from '../components/common/Button.jsx';
import NewProjectModal from '../components/project/NewProjectModal.jsx';
import StackModal from '../components/recreate/StackModal.jsx';
import { useProjects, useSelectedProject } from '../store/useProjects.js';
import styles from './AppShell.module.css';
import { useSyncScroll } from './useSyncScroll.js';

const SIDEBAR_KEY = 'wa:sidebarCollapsed';

// Collapsed sidebar, remembered per browser. Storage can be unavailable: then it is not remembered.
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable — ignore */
    }
  }, [collapsed]);
  // Ctrl+B / ⌘B toggles it (the common editor shortcut).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [collapsed, setCollapsed];
}

export default function AppShell() {
  const load = useProjects((s) => s.load);
  const error = useProjects((s) => s.error);
  const audit = useProjects((s) => s.audit);
  const auditLoading = useProjects((s) => s.auditLoading);
  const project = useSelectedProject();

  const [newOpen, setNewOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [tab, setTab] = useState('old'); // narrow screens only
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  // Sync scroll: off by default and not remembered. The OLD screenshot and the NEW page (drawn at full
  // height) scroll by the same share of their height, so both show the same part of the site.
  const [syncScroll, setSyncScroll] = useState(false);
  const [oldScroller, setOldScroller] = useState(null);
  const [newScroller, setNewScroller] = useState(null);
  useSyncScroll(oldScroller, newScroller, syncScroll);
  // The page the NEW preview shows: the OLD preview shows the same page of the original.
  const [comparePage, setComparePage] = useState(null);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className={styles.brandName}>Site Audit Studio</span>
          <span className={`${styles.version} mono`}>v0.3 · phase 3</span>
        </div>
        <Disclaimer />
      </header>

      <div className={styles.main}>
        <Sidebar
          onNewProject={() => setNewOpen(true)}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
        />

        {error && !project && <div className={styles.center}>API error: {error}</div>}

        {!error && !project && (
          <div className={styles.center}>
            <div className={styles.emptyCard}>
              <span className={styles.emptyIcon}>
                <Globe size={20} />
              </span>
              <h1>No project selected</h1>
              <p>Add a website — its audit appears in the OLD panel and the recreated version in the NEW panel.</p>
              <Button variant="primary" icon={Plus} onClick={() => setNewOpen(true)}>
                New Project
              </Button>
            </div>
          </div>
        )}

        {project && (
          <div className={styles.panels} data-tab={tab}>
            <div className={styles.sync}>
              <button
                type="button"
                className={styles.syncToggle}
                aria-pressed={syncScroll}
                aria-describedby="sync-scroll-hint"
                onClick={() => setSyncScroll((on) => !on)}
              >
                <ArrowUpDown size={16} aria-hidden="true" />
                <span>{syncScroll ? 'Sync on' : 'Sync scroll'}</span>
              </button>
              <span id="sync-scroll-hint" role="tooltip" className={styles.syncHint}>
                Sync scroll works in Shot mode only (Live sites can't be controlled due to browser security).
              </span>
            </div>
            <div className={styles.tabs} role="tablist" aria-label="Panels">
              {['old', 'new'].map((t) => (
                <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === 'old' ? 'OLD · Original' : 'NEW · Recreated'}
                </button>
              ))}
            </div>
            <OldPanel
              key={`old-${project.id}`}
              project={project}
              audit={audit}
              loading={auditLoading}
              onOpenStack={() => setStackOpen(true)}
              syncScroll={syncScroll}
              onShotScroller={setOldScroller}
              comparePage={comparePage}
            />
            <NewPanel
              key={`new-${project.id}`}
              project={project}
              audit={audit}
              syncScroll={syncScroll}
              onFrameScroller={setNewScroller}
              onPageChange={setComparePage}
            />
          </div>
        )}
      </div>

      <NewProjectModal open={newOpen} onClose={() => setNewOpen(false)} />
      {project && <StackModal open={stackOpen} onClose={() => setStackOpen(false)} project={project} />}
    </div>
  );
}
