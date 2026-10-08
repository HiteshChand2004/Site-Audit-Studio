import { useEffect, useState } from 'react';
import { ChevronRight, FileText, Globe } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import Workspace from './Workspace.jsx';
import Home from './Home.jsx';
import Button from '../components/common/Button.jsx';
import { EmptyState } from '../components/common/Surface.jsx';
import { SiteIcon } from '../components/site/Site.jsx';
import NewProjectModal from '../components/project/NewProjectModal.jsx';
import ReportModal from '../components/report/ReportModal.jsx';
import StackModal from '../components/recreate/StackModal.jsx';
import { hostOf } from '../constants.js';
import { useProjects, useSelectedProject } from '../store/useProjects.js';
import styles from './AppShell.module.css';

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
  const refreshSelected = useProjects((s) => s.refreshSelected);
  const goHome = useProjects((s) => s.goHome);
  // Coming back to the tab shows the newest check and copy (work may have finished or been added meanwhile).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSelected();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshSelected]);
  const error = useProjects((s) => s.error);
  const audit = useProjects((s) => s.audit);
  const auditLoading = useProjects((s) => s.auditLoading);
  const project = useSelectedProject();

  const [newOpen, setNewOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className={styles.app}>
      <Sidebar onNewProject={() => setNewOpen(true)} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((c) => !c)} />

      <div className={styles.main}>
        <header className={styles.topbar}>
          <nav className={styles.crumbs} aria-label="You are here">
            {project ? (
              <>
                <button type="button" className={styles.crumbLink} onClick={goHome}>
                  All websites
                </button>
                <ChevronRight size={14} aria-hidden="true" className={styles.crumbSep} />
                <span className={styles.crumbHere} aria-current="page">
                  <SiteIcon project={project} host={hostOf(project.url)} size={20} />
                  {hostOf(project.url)}
                </span>
              </>
            ) : (
              <span className={styles.crumbHere} aria-current="page">
                All websites
              </span>
            )}
          </nav>
          <div className={styles.topActions}>
            {project && (
              <Button size="sm" icon={FileText} onClick={() => setReportOpen(true)} title="One report of the check, the copy and what got better (PDF, HTML or data)">
                Full report
              </Button>
            )}
          </div>
        </header>

        {error && !project ? (
          <div className={styles.center}>
            <EmptyState icon={Globe} title="The app cannot reach its server">
              {error}
            </EmptyState>
          </div>
        ) : project ? (
          <Workspace
            key={project.id}
            project={project}
            audit={audit}
            auditLoading={auditLoading}
            onOpenSettings={() => setStackOpen(true)}
            onOpenReport={() => setReportOpen(true)}
          />
        ) : (
          <Home onNewProject={() => setNewOpen(true)} />
        )}
      </div>

      <NewProjectModal open={newOpen} onClose={() => setNewOpen(false)} />
      {project && <StackModal open={stackOpen} onClose={() => setStackOpen(false)} project={project} />}
      {project && <ReportModal key={project.id} open={reportOpen} onClose={() => setReportOpen(false)} project={project} />}
    </div>
  );
}
