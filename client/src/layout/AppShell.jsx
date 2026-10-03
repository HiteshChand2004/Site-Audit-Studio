import { useEffect, useState } from 'react';
import { FileText, Globe, Plus } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import Workspace from './Workspace.jsx';
import Disclaimer from '../components/common/Disclaimer.jsx';
import Button from '../components/common/Button.jsx';
import { EmptyState } from '../components/common/Surface.jsx';
import NewProjectModal from '../components/project/NewProjectModal.jsx';
import ReportModal from '../components/report/ReportModal.jsx';
import StackModal from '../components/recreate/StackModal.jsx';
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
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className={styles.brandName}>Site Audit Studio</span>
        </div>
        <div className={styles.topActions}>
          {project && (
            <Button icon={FileText} onClick={() => setReportOpen(true)} title="One report of the check, the copy and what got better (PDF, HTML or data)">
              Full report
            </Button>
          )}
          <Disclaimer />
        </div>
      </header>

      <div className={styles.main}>
        <Sidebar
          onNewProject={() => setNewOpen(true)}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
        />

        {error && !project && (
          <div className={styles.center}>
            <EmptyState icon={Globe} title="The app cannot reach its server">
              {error}
            </EmptyState>
          </div>
        )}

        {!error && !project && (
          <div className={styles.center}>
            <EmptyState
              icon={Globe}
              title="Start with a website"
              action={
                <Button variant="primary" size="lg" icon={Plus} onClick={() => setNewOpen(true)}>
                  Add a website
                </Button>
              }
            >
              Add one of your websites. The app checks how healthy it is, builds a clean copy, shows both side by side and lists what got better.
            </EmptyState>
          </div>
        )}

        {project && (
          <Workspace
            key={project.id}
            project={project}
            audit={audit}
            auditLoading={auditLoading}
            onOpenSettings={() => setStackOpen(true)}
            onOpenReport={() => setReportOpen(true)}
          />
        )}
      </div>

      <NewProjectModal open={newOpen} onClose={() => setNewOpen(false)} />
      {project && <StackModal open={stackOpen} onClose={() => setStackOpen(false)} project={project} />}
      {project && <ReportModal key={project.id} open={reportOpen} onClose={() => setReportOpen(false)} project={project} />}
    </div>
  );
}
