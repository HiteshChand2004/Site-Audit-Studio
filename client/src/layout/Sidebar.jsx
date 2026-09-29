import { useMemo, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, Plus, Search, Trash2 } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import { useProjects } from '../store/useProjects.js';
import { hostOf, stackById } from '../constants.js';
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

/** Collapsed sidebar content: a thin rail with the toggle, New Project and one initial per website. */
function Rail({ projects, selectedId, select, onNewProject, onToggle }) {
  return (
    <>
      <div className={styles.railTop}>
        <ToggleButton collapsed onToggle={onToggle} />
        <button type="button" className={`${styles.iconBtn} ${styles.railNew}`} onClick={onNewProject} aria-label="New Project" title="New Project">
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
              data-active={active}
              aria-current={active ? 'page' : undefined}
              aria-label={`${p.name} (${host})`}
              title={`${p.name} · ${host}`}
              onClick={() => select(p.id)}
            >
              <span className={styles.avatar} aria-hidden="true">
                {host.charAt(0).toUpperCase()}
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
}

export default function Sidebar({ onNewProject, collapsed = false, onToggle }) {
  const { projects, loading, selectedId, select, remove } = useProjects();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.url.toLowerCase().includes(q));
  }, [projects, query]);

  const confirmDelete = (e, project) => {
    e.stopPropagation();
    if (window.confirm(`Delete project "${project.name}"?`)) remove(project.id);
  };

  // One <aside> in both states, so its width can animate between the rail and the full sidebar.
  return (
    <aside id="project-sidebar" className={styles.sidebar} data-collapsed={collapsed} aria-label="Projects">
      {collapsed ? (
        <Rail projects={projects} selectedId={selectedId} select={select} onNewProject={onNewProject} onToggle={onToggle} />
      ) : (
        <>
          <div className={styles.top}>
            <div className={styles.topRow}>
              <Button variant="primary" icon={Plus} onClick={onNewProject} className={styles.newBtn}>
                New Project
              </Button>
              {onToggle && <ToggleButton collapsed={false} onToggle={onToggle} />}
            </div>
            <label className={styles.search}>
              <Search size={14} aria-hidden="true" />
              <input
                placeholder="Filter websites"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter websites"
              />
            </label>
          </div>
    
          <div className={styles.sectionLabel}>
            <span>Websites</span>
            <span className="mono">{projects.length}</span>
          </div>
    
          <nav className={`${styles.list} scroll`}>
            {loading && <p className={styles.hint}>Loading…</p>}
            {!loading && projects.length === 0 && (
              <p className={styles.hint}>No websites yet. Add your first site with “New Project”.</p>
            )}
            {!loading && projects.length > 0 && filtered.length === 0 && (
              <p className={styles.hint}>No matches for “{query}”.</p>
            )}
            {filtered.map((p) => {
              const host = hostOf(p.url);
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  className={styles.item}
                  data-active={p.id === selectedId}
                  aria-current={p.id === selectedId ? 'page' : undefined}
                  onClick={() => select(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      select(p.id);
                    }
                  }}
                >
                  <span className={styles.avatar} aria-hidden="true">
                    {host.charAt(0).toUpperCase()}
                  </span>
                  <span className={styles.text}>
                    <span className={styles.name}>{p.name}</span>
                    <span className={`${styles.host} mono`}>{host}</span>
                  </span>
                  <span className={styles.stack}>{stackById(p.stack).short}</span>
                  <button
                    type="button"
                    className={styles.delete}
                    onClick={(e) => confirmDelete(e, p)}
                    aria-label={`Delete ${p.name}`}
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </nav>
        </>
      )}
    </aside>
  );
}
