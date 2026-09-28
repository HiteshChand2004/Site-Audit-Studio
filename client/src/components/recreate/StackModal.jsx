import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { STACKS } from '../../constants.js';
import { useProjects } from '../../store/useProjects.js';
import styles from './StackModal.module.css';
import form from '../common/Form.module.css';

const MAX_PAGES = 20;

export default function StackModal({ open, onClose, project }) {
  const update = useProjects((s) => s.update);
  const [choice, setChoice] = useState(project?.stack ?? 'html');
  const [pages, setPages] = useState(String(project?.recreate_pages ?? 5));
  const [domain, setDomain] = useState(project?.target_domain ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setChoice(project?.stack ?? 'html');
      setPages(String(project?.recreate_pages ?? 5));
      setDomain(project?.target_domain ?? '');
      setError(null);
    }
  }, [open, project?.stack, project?.recreate_pages, project?.target_domain]);

  const save = async () => {
    const n = Number(pages);
    if (!Number.isInteger(n) || n < 0 || n > MAX_PAGES) {
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
      title="Output stack"
      description="Choose the stack the recreated site is generated in and how Recreate runs. Saved per project."
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
      <div className={styles.grid} role="radiogroup" aria-label="Output stack">
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
        <label className={form.field}>
          <span className={form.label}>Pages besides the homepage</span>
          <input
            className={`${form.input} mono`}
            type="number"
            min={0}
            max={MAX_PAGES}
            value={pages}
            onChange={(e) => setPages(e.target.value)}
          />
          <span className={styles.hint}>Recreate copies the homepage plus this many pages (0–{MAX_PAGES}).</span>
        </label>
        <label className={form.field}>
          <span className={form.label}>
            Target domain<span className={form.optional}>optional</span>
          </span>
          <input
            className={`${form.input} mono`}
            placeholder="https://new.example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <span className={styles.hint}>Used for canonical, sitemap.xml and Open Graph URLs. Empty = the original domain.</span>
        </label>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </Modal>
  );
}
