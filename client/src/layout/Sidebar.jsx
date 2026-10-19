import { useMemo, useState } from 'react';
import { LayoutGrid, PanelLeftClose, PanelLeftOpen, Plus, Search, Trash2, X } from 'lucide-react';
import ConfirmDialog from '../components/common/ConfirmDialog.jsx';
import Disclaimer from '../components/common/Disclaimer.jsx';
import { LogoMark } from '../components/common/Illustrations.jsx';
import { SiteIcon, StageDots } from '../components/site/Site.jsx';
import { useSiteData } from '../siteData.js';
import { useProjects } from '../store/useProjects.js';
import { hostOf } from '../constants.js';
import styles from './Sidebar.module.css';

const SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘B' : 'Ctrl+B';

function ToggleButton({ collapsed, onToggle }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <button
      type="button"
      className={styles.iconBtn}
      onClick={onToggle}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls="project-sidebar"
      title={`${label} (${SHORTCUT})`}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

/** One website in the list: icon, address and where its work stands. */
function SiteItem({ project, active, onSelect, onRemove }) {
  const host = hostOf(project.url);
  const { stages, loaded } = useSiteData(project.id);
  const running = Object.values(stages).includes('running');
  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.item}
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      aria-label={`${project.name}${running ? ', working' : ''}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className={styles.iconWrap}>
        <SiteIcon project={project} host={host} size={30} />
        {running && <span className={styles.live} aria-hidden="true" />}
      </span>
      <span className={styles.text}>
        <span className={styles.name}>{host}</span>
        <span className={styles.meta}>{loaded ? <StageDots stages={stages} /> : <span className={`${styles.metaSkeleton} skeleton`} />}</span>
      </span>
      <button type="button" className={styles.delete} onClick={onRemove} aria-label={`Remove ${project.name}`} title="Remove from the app">
        <Trash2 size={13} />
      </button>
    </div>
  );
}

/** Collapsed sidebar content: a thin rail with the logo, toggle, home, Add and one icon per website. */
function Rail({ projects, selectedId, select, goHome, onNewProject, onToggle }) {
  return (
    <>
      <div className={styles.railTop}>
        <LogoMark size={30} />
        <ToggleButton collapsed onToggle={onToggle} />
        <button type="button" className={styles.iconBtn} data-active={!selectedId || undefined} onClick={goHome} aria-label="All websites" title="All websites">
          <LayoutGrid size={16} aria-hidden="true" />
        </button>
        <button type="button" className={`${styles.iconBtn} ${styles.railNew}`} onClick={onNewProject} aria-label="Add a website" title="Add a website">
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      <nav className={`${styles.railList} scroll`} aria-label="Websites">
        {projects.map((p) => {
          const host = hostOf(p.url);
          const active = p.id === selectedId;
          return (
            <button
              key={p.id}
              type="button"
              className={styles.railItem}
              data-active={active || undefined}
              aria-current={active ? 'page' : undefined}
              aria-label={`${p.name} (${host})`}
              title={`${p.name} · ${host}`}
              onClick={() => select(p.id)}
            >
              <SiteIcon project={p} host={host} size={30} />
            </button>
          );
        })}
      </nav>
      <Disclaimer compact />
    </>
  );
}

export default function Sidebar({ onNewProject, collapsed = false, onToggle }) {
  const { projects, loading, selectedId, select, remove, goHome } = useProjects();
  const [query, setQuery] = useState('');
  const [toDelete, setToDelete] = useState(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.url.toLowerCase().includes(q));
  }, [projects, query]);

  // One <aside> in both states, so its width can animate between the rail and the full sidebar.
  return (
    <aside id="project-sidebar" className={styles.sidebar} data-collapsed={collapsed} aria-label="Websites">
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Remove this website?"
        confirmLabel="Remove"
        danger
        onConfirm={() => remove(toDelete.id)}
      >
        <p>
          <strong>{toDelete?.name}</strong> and everything saved for it (checks, copies, screenshots) will be removed from this app. The
          real website is not affected.
        </p>
      </ConfirmDialog>
      {collapsed ? (
        <Rail projects={projects} selectedId={selectedId} select={select} goHome={goHome} onNewProject={onNewProject} onToggle={onToggle} />
      ) : (
        <>
          <div className={styles.brandRow}>
            <button type="button" className={styles.brand} onClick={goHome} title="All websites">
              <LogoMark size={30} />
              <span className={styles.brandText}>
                <span className={styles.brandName}>Site Audit Studio</span>
                <span className={styles.brandSub}>Check · copy · improve</span>
              </span>
            </button>
            {onToggle && <ToggleButton collapsed={false} onToggle={onToggle} />}
          </div>

          <div className={styles.top}>
            <button type="button" className={styles.navItem} data-active={!selectedId || undefined} aria-current={!selectedId ? 'page' : undefined} onClick={goHome}>
              <LayoutGrid size={16} aria-hidden="true" />
              <span>All websites</span>
              <span className={`${styles.count} tabular`}>{projects.length}</span>
            </button>
            <button type="button" className={styles.addBtn} onClick={onNewProject}>
              <Plus size={16} aria-hidden="true" />
              <span>Add a website</span>
            </button>
          </div>

          <div className={styles.sectionHead}>
            <span className="eyebrow">Your websites</span>
          </div>
          <label className={styles.search}>
            <Search size={14} aria-hidden="true" />
            <input placeholder="Search your websites" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search your websites" />
            {query && (
              <button type="button" className={styles.clear} onClick={() => setQuery('')} aria-label="Clear the search">
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </label>

          <nav className={`${styles.list} scroll`} aria-label="Your websites">
            {loading &&
              [0, 1, 2].map((i) => (
                <div key={i} className={styles.itemSkeleton} aria-hidden="true">
                  <span className="skeleton" />
                  <span>
                    <span className="skeleton" />
                    <span className="skeleton" />
                  </span>
                </div>
              ))}
            {!loading && projects.length === 0 && <p className={styles.hint}>No websites yet. Add one to start.</p>}
            {!loading && projects.length > 0 && filtered.length === 0 && <p className={styles.hint}>No matches for “{query}”.</p>}
            {filtered.map((p) => (
              <SiteItem
                key={p.id}
                project={p}
                active={p.id === selectedId}
                onSelect={() => select(p.id)}
                onRemove={(e) => {
                  e.stopPropagation();
                  setToDelete(p);
                }}
              />
            ))}
          </nav>

          <div className={styles.legend}>
            <StageDots stages={{ check: 'done', copy: 'done', results: 'done' }} />
            <span>Checked · Copy made · Compared</span>
          </div>
          <Disclaimer />
        </>
      )}
    </aside>
  );
}
