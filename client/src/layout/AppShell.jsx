import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight, FileText, Globe, Menu } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import Workspace from './Workspace.jsx';
import Home from './Home.jsx';
import BuildMode from './BuildMode.jsx';
import Button from '../components/common/Button.jsx';
import { EmptyState } from '../components/common/Surface.jsx';
import { SiteIcon } from '../components/site/Site.jsx';
import { LogoMark } from '../components/common/Illustrations.jsx';
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

// Below this width the sidebar is a drawer opened from the top bar (the same value as the CSS modules' breakpoint).
const NARROW = '(max-width: 760px)';

function useNarrow() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(NARROW);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/**
 * The drawer on narrow screens: focus moves into it when it opens and back to the menu button when it closes, Escape closes
 * it (unless a menu or dialog inside it takes the key first), and the page behind it does not scroll.
 */
function useDrawer(narrow) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  // Focus goes back to the menu button, unless what was chosen moved it elsewhere (a dialog that opened, say).
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || panelRef.current?.contains(active)) buttonRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!narrow) setOpen(false);
  }, [narrow]);

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.querySelector('[data-drawer-close]')?.focus();
    const onKey = (e) => {
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Tab' && panelRef.current) {
        // Tab goes round inside the drawer (the page behind it is inert).
        const items = [...panelRef.current.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter(
          (el) => !el.disabled && el.getClientRects().length > 0,
        );
        const first = items[0];
        const last = items[items.length - 1];
        const at = document.activeElement;
        if (e.shiftKey && (at === first || !panelRef.current.contains(at))) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && (at === last || !panelRef.current.contains(at))) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  return { open, setOpen, close, buttonRef, panelRef };
}

/** ?site= in the address (the sign-up form's optional "Website to rebuild"), or ''. */
function siteFromUrl() {
  try {
    return (new URLSearchParams(window.location.search).get('site') ?? '').trim().slice(0, 2000);
  } catch {
    return '';
  }
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
  const building = useProjects((s) => s.building);
  const openBuild = useProjects((s) => s.openBuild);
  // The tab title in the marketing site's form ("%s · Remastly"): the open website, else the list of them.
  useEffect(() => {
    document.title = project ? `${project.name} · Remastly` : building ? 'Build a site · Remastly' : 'Your websites · Remastly';
  }, [project, building]);

  // "Website to rebuild" from the sign-up form arrives as /app/?site=<address>: the Add a website form opens with it filled
  // in (still to be confirmed, authorization box included), and the address leaves the URL so a reload does not ask again.
  const [newOpen, setNewOpen] = useState(() => Boolean(siteFromUrl()));
  const [newUrl] = useState(siteFromUrl);
  useEffect(() => {
    if (!siteFromUrl()) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('site');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);
  // The settings dialog: null = closed, 'settings' = Change settings, 'before-create' = the new site's address is asked before a copy is made.
  const [stackMode, setStackMode] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  const narrow = useNarrow();
  const drawer = useDrawer(narrow);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className={styles.app}>
      <Sidebar
        onNewProject={() => setNewOpen(true)}
        collapsed={sidebarCollapsed && !narrow}
        onToggle={() => setSidebarCollapsed((c) => !c)}
        drawer={narrow}
        open={drawer.open}
        onClose={drawer.close}
        panelRef={drawer.panelRef}
      />
      {narrow && <div className={styles.scrim} data-open={drawer.open || undefined} onClick={drawer.close} aria-hidden="true" />}

      <div className={styles.main} inert={(narrow && drawer.open) || undefined}>
        <header className={styles.topbar}>
          {narrow && (
            <>
              <button
                ref={drawer.buttonRef}
                type="button"
                className={styles.menuBtn}
                onClick={() => drawer.setOpen(true)}
                aria-label="Menu"
                aria-expanded={drawer.open}
                aria-controls="project-sidebar"
              >
                <Menu size={20} aria-hidden="true" />
              </button>
              <button type="button" className={styles.homeMark} onClick={goHome} aria-label="Remastly, all websites">
                <LogoMark size={26} />
              </button>
            </>
          )}
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
            ) : building ? (
              <>
                <button type="button" className={styles.crumbLink} onClick={goHome}>
                  All websites
                </button>
                <ChevronRight size={14} aria-hidden="true" className={styles.crumbSep} />
                <span className={styles.crumbHere} aria-current="page">
                  Build a site
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
            onOpenSettings={(mode = 'settings') => setStackMode(mode)}
            onOpenReport={() => setReportOpen(true)}
          />
        ) : building ? (
          <BuildMode />
        ) : (
          <Home onNewProject={() => setNewOpen(true)} onBuild={openBuild} />
        )}
      </div>

      <NewProjectModal open={newOpen} initialUrl={newUrl} onClose={() => setNewOpen(false)} />
      {project && (
        <StackModal open={Boolean(stackMode)} askAddress={stackMode === 'before-create'} onClose={() => setStackMode(null)} project={project} />
      )}
      {project && <ReportModal key={project.id} open={reportOpen} onClose={() => setReportOpen(false)} project={project} />}
    </div>
  );
}
