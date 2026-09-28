import { useState } from 'react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { useProjects } from '../../store/useProjects.js';
import styles from '../common/Form.module.css';

const EMPTY = { name: '', url: '', authorized: false };

export default function NewProjectModal({ open, onClose }) {
  const create = useProjects((s) => s.create);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const close = () => {
    setForm(EMPTY);
    setError(null);
    onClose();
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await create(form);
      close();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = form.url.trim() && form.authorized && !saving;

  return (
    <Modal
      open={open}
      onClose={close}
      title="New project"
      description="Website add karein. Analyze aur Recreate baad me is project se chalenge."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-project" disabled={!canSubmit}>
            {saving ? 'Creating…' : 'Create project'}
          </Button>
        </>
      }
    >
      <form id="new-project" className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span className={styles.label}>Website URL</span>
          <input
            className={`${styles.input} mono`}
            placeholder="https://example.com"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            autoFocus
            required
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>
            Name <span className={styles.optional}>optional</span>
          </span>
          <input
            className={styles.input}
            placeholder="Marketing site"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={form.authorized}
            onChange={(e) => setForm({ ...form, authorized: e.target.checked })}
          />
          <span>
            Main confirm karta/karti hoon ki ye website hamari company ki hai, ya iska audit aur
            recreate karne ki permission hai.
          </span>
        </label>
        {error && <p className={styles.error}>{error}</p>}
      </form>
    </Modal>
  );
}
