import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { STACKS } from '../../constants.js';
import { useProjects } from '../../store/useProjects.js';
import styles from './StackModal.module.css';
import form from '../common/Form.module.css';

// Pages besides the homepage when a limit is set; -1 = every page of the site (the default, up to the server's safety cap).
const MAX_PAGES = 300;
const ALL_PAGES = -1;
const isAll = (v) => v == null || v === ALL_PAGES;

export default function StackModal({ open, onClose, project }) {
  const update = useProjects((s) => s.update);
  const [choice, setChoice] = useState(project?.stack ?? 'html');
  const [all, setAll] = useState(isAll(project?.recreate_pages));
  const [pages, setPages] = useState(String(isAll(project?.recreate_pages) ? 5 : project.recreate_pages));
  const [domain, setDomain] = useState(project?.target_domain ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setChoice(project?.stack ?? 'html');
      setAll(isAll(project?.recreate_pages));
      setPages(String(isAll(project?.recreate_pages) ? 5 : project.recreate_pages));
      setDomain(project?.target_domain ?? '');
      setError(null);
    }
  }, [open, project?.stack, project?.recreate_pages, project?.target_domain]);

  const save = async () => {
    const n = all ? ALL_PAGES : Number(pages);
    if (!all && (!Number.isInteger(n) || n < 0 || n > MAX_PAGES)) {
      setError(`Pages must be a whole number from 0 to ${MAX_PAGES}.`);
      return;
    }
    setSaving(true);
    try {
      await update(project.id, { stack: choice, recreate_pages: n, target_domain: domain.trim() || null });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title="Settings for the copy"
      description="Which technology the new site is built with, which pages are copied, and its future address. Saved for this website."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className={styles.grid} role="radiogroup" aria-label="Technology of the new site">
        {STACKS.map((stack) => {
          const selected = choice === stack.id;
          return (
            <button
              key={stack.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={styles.option}
              data-selected={selected}
              onClick={() => setChoice(stack.id)}
            >
              <span className={styles.radio} aria-hidden="true">
                {selected && <Check size={11} strokeWidth={3} />}
              </span>
              <span className={styles.name}>{stack.name}</span>
              <span className={styles.detail}>{stack.detail}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.settings}>
        <div className={form.field}>
          <span className={form.label}>Pages</span>
          <label className={form.check}>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>
              Every page of the site. Every link in the new site then opens a page of the new site; the time limit grows with
              the number of pages.
            </span>
          </label>
          {!all && (
            <>
              <input
                className={`${form.input} mono`}
                type="number"
                min={0}
                max={MAX_PAGES}
                aria-label="Pages besides the homepage"
                value={pages}
                onChange={(e) => setPages(e.target.value)}
              />
              <span className={styles.hint}>The homepage plus this many pages (0–{MAX_PAGES}).</span>
            </>
          )}
        </div>
        <label className={form.field}>
          <span className={form.label}>
            Future address of the new site<span className={form.optional}>optional</span>
          </span>
          <input
            className={`${form.input} mono`}
            placeholder="https://new.example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <span className={styles.hint}>Where the new site will live. Search engines and link previews are told this address. Leave empty to keep the original address.</span>
        </label>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </Modal>
  );
}
