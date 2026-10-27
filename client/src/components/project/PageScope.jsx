import { useEffect, useId, useState } from 'react';
import { FileText, Globe } from 'lucide-react';
import Button from '../common/Button.jsx';
import { Segmented } from '../common/Tabs.jsx';
import { api } from '../../api/client.js';
import { useProjects } from '../../store/useProjects.js';
import styles from './PageScope.module.css';

/** The path of an address, for showing: "/pricing", "/" for the homepage. */
export const pathOf = (url) => {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
};

/**
 * What the check and the copy cover: the whole website (as always) or one page of it, chosen from the pages the app has
 * already found or typed in. The choice is saved on the website; the next check and the next copy follow it, and their
 * results then show that page only.
 */
export default function PageScope({ project, disabled = false }) {
  const update = useProjects((s) => s.update);
  const listId = useId();
  const [mode, setMode] = useState(project.page_url ? 'page' : 'whole');
  const [value, setValue] = useState(project.page_url ? pathOf(project.page_url) : '');
  const [pages, setPages] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(project.page_url ? 'page' : 'whole');
    setValue(project.page_url ? pathOf(project.page_url) : '');
  }, [project.id, project.page_url]);
  useEffect(() => {
    let live = true;
    api.getPages(project.id).then((r) => live && setPages(r.pages ?? []), () => {});
    return () => {
      live = false;
    };
  }, [project.id, project.page_url]);

  const save = async (pageUrl) => {
    setSaving(true);
    setError(null);
    try {
      await update(project.id, { page_url: pageUrl });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const choose = (next) => {
    setMode(next);
    setError(null);
    if (next === 'whole' && project.page_url) save(null);
  };
  // A path from the list is sent as the full address of that page; anything typed goes as typed (the server checks it is
  // a page of this website).
  const submit = (e) => {
    e.preventDefault();
    const typed = value.trim();
    if (!typed) return;
    const known = pages.find((p) => p.path === typed || p.url === typed);
    save(known ? known.url : typed);
  };
  const chosen = project.page_url ? pathOf(project.page_url) : null;
  const pending = mode === 'page' && value.trim() && value.trim() !== chosen;

  return (
    <div className={styles.scope}>
      <div className={styles.row}>
        <span className={styles.label}>What to check and copy</span>
        <Segmented
          size="sm"
          label="What to check and copy"
          value={mode}
          onChange={disabled || saving ? () => {} : choose}
          options={[
            { value: 'whole', label: 'Whole website', icon: Globe, title: 'Every page of the site (as always)' },
            { value: 'page', label: 'One page', icon: FileText, title: 'Only the page you choose' },
          ]}
        />
      </div>
      {mode === 'page' && (
        <form className={styles.row} onSubmit={submit}>
          <input
            className={`mono ${styles.input}`}
            list={listId}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Pick a page from the list, or type its address"
            aria-label="The page to check and copy"
            disabled={disabled || saving}
          />
          <datalist id={listId}>
            {pages.map((p) => (
              <option key={p.path} value={p.path} />
            ))}
          </datalist>
          <Button type="submit" size="sm" variant={pending ? 'primary' : 'secondary'} disabled={disabled || saving || !value.trim() || !pending}>
            {chosen && !pending ? 'Chosen' : 'Use this page'}
          </Button>
        </form>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <p className={styles.note}>
        {chosen
          ? <>Only <strong className="mono">{chosen}</strong> is checked and copied; the report, the copy and the results show this page only. Check again after changing it.</>
          : mode === 'page'
            ? 'Choose a page from the list (the pages found so far) or type its address on this website.'
            : 'Every page of the website is checked and copied.'}
      </p>
    </div>
  );
}
