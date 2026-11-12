import { useEffect, useMemo, useState } from 'react';
import { Check, PenLine, Search, X } from 'lucide-react';
import Button from '../common/Button.jsx';
import { Card } from '../common/Surface.jsx';
import { Segmented } from '../common/Tabs.jsx';
import form from '../common/Form.module.css';
import { timeAgo } from '../../format.js';
import { KIND_NAMES, pageName } from './words.js';
import styles from './AfterBuild.module.css';

const SHOWN = 25;

/** One text block of a page: read, or being changed. */
function Block({ block, page, onEdit, slow }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(block.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onEdit(page, block.text, value);
      // The block is replaced by the page's new words; nothing more to do here.
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  if (!block.editable) {
    return (
      <li className={styles.block} data-locked>
        <span className={styles.kind}>{KIND_NAMES[block.kind] ?? 'Text'}</span>
        <span className={styles.blockText}>{block.text}</span>
        <span className={styles.why}>{block.why}</span>
      </li>
    );
  }
  return (
    <li className={styles.block}>
      <span className={styles.kind}>{KIND_NAMES[block.kind] ?? 'Text'}</span>
      {editing ? (
        <form className={styles.editForm} onSubmit={save}>
          <textarea
            className={`${form.input} ${styles.editArea}`}
            rows={Math.min(6, Math.max(2, Math.ceil(value.length / 70)))}
            value={value}
            maxLength={2000}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setValue(block.text); } }}
            aria-label={`New text for “${block.text.slice(0, 60)}”`}
            aria-invalid={Boolean(error) || undefined}
            autoFocus
          />
          <div className={styles.editActions}>
            <Button type="submit" variant="primary" size="sm" icon={Check} disabled={saving || !value.trim() || value.trim() === block.text}>
              {saving ? (slow ? 'Saving and checking…' : 'Saving…') : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" icon={X} disabled={saving} onClick={() => { setEditing(false); setValue(block.text); setError(''); }}>Cancel</Button>
            {saving && slow && <span className={styles.note}>The site is rebuilt and checked: about half a minute.</span>}
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
        </form>
      ) : (
        <>
          <span className={styles.blockText}>{block.text}</span>
          <Button size="sm" variant="ghost" icon={PenLine} onClick={() => setEditing(true)}>Change</Button>
        </>
      )}
    </li>
  );
}

/** The words of each built page, changed one at a time without the AI. */
export default function EditText({ texts, run, onEdit }) {
  const pages = texts.pages.filter((p) => p.blocks.length);
  const [path, setPath] = useState(pages[0]?.path ?? '/');
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [locked, setLocked] = useState(false);
  useEffect(() => { if (!pages.some((p) => p.path === path) && pages[0]) setPath(pages[0].path); }, [pages, path]);
  const page = pages.find((p) => p.path === path) ?? pages[0];
  const slow = texts.stack !== 'html';

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (page?.blocks ?? []).filter((b) => !q || b.text.toLowerCase().includes(q));
  }, [page, query]);
  const editable = matching.filter((b) => b.editable);
  const fixed = matching.filter((b) => !b.editable);
  const listed = all || query ? editable : editable.slice(0, SHOWN);
  const recent = [...(run.edits ?? [])].reverse().slice(0, 3);

  if (!page) return null;
  return (
    <Card
      title="Change the words"
      sub={`Fix a heading, a sentence or a button without building again. ${slow ? 'Each change is rebuilt and checked, in about half a minute.' : 'Each change is saved and checked in seconds.'}`}
    >
      <div className={styles.toolbar}>
        {pages.length <= 6 ? (
          <Segmented size="sm" label="Page" value={page.path} onChange={(v) => { setPath(v); setAll(false); }} options={pages.map((p) => ({ value: p.path, label: pageName(p.path) }))} />
        ) : (
          <select className={`${form.input} ${styles.pageSelect}`} aria-label="Page" value={page.path} onChange={(e) => { setPath(e.target.value); setAll(false); }}>
            {pages.map((p) => <option key={p.path} value={p.path}>{pageName(p.path)}</option>)}
          </select>
        )}
        <label className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <input className={form.input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find text on this page" aria-label="Find text on this page" />
        </label>
      </div>

      {editable.length === 0 ? (
        <p className={styles.note}>{query ? 'No text on this page matches.' : 'None of the text on this page can be changed here.'}</p>
      ) : (
        <ul className={styles.blocks}>
          {listed.map((b) => <Block key={`${page.path}${b.text}`} block={b} page={page.path} onEdit={onEdit} slow={slow} />)}
        </ul>
      )}
      {listed.length < editable.length && (
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>Show all {editable.length}</Button>
      )}

      {fixed.length > 0 && (
        <div className={styles.lockedPart}>
          <Button size="sm" variant="ghost" aria-expanded={locked} onClick={() => setLocked(!locked)}>
            {locked ? 'Hide' : 'Show'} the {fixed.length === 1 ? 'text' : `${fixed.length} bits of text`} that can’t be changed here
          </Button>
          {locked && <ul className={styles.blocks}>{fixed.map((b) => <Block key={`${page.path}${b.text}`} block={b} page={page.path} onEdit={onEdit} />)}</ul>}
        </div>
      )}

      {recent.length > 0 && (
        <div className={styles.recent}>
          <p className={styles.recentTitle}>Your latest changes</p>
          <ul className={styles.recentList}>
            {recent.map((e) => (
              <li key={`${e.at}${e.from}`}>
                <span className={styles.note}>{timeAgo(e.at)}{e.page ? ` · ${pageName(e.page)}` : ''}</span>
                <span><s className={styles.old}>{e.from}</s> → {e.to}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
