import { useMemo, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import { useProjects } from '../store/useProjects.js';
import { hostOf, stackById } from '../constants.js';
import styles from './Sidebar.module.css';

export default function Sidebar({ onNewProject }) {
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

  return (
    <aside className={styles.sidebar} aria-label="Projects">
      <div className={styles.top}>
        <Button variant="primary" icon={Plus} onClick={onNewProject} className={styles.newBtn}>
          New Project
        </Button>
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
    </aside>
  );
}
