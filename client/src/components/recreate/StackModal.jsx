import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { STACKS } from '../../constants.js';
import { useProjects } from '../../store/useProjects.js';
import styles from './StackModal.module.css';

export default function StackModal({ open, onClose, project }) {
  const update = useProjects((s) => s.update);
  const [choice, setChoice] = useState(project?.stack ?? 'html');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setChoice(project?.stack ?? 'html');
      setError(null);
    }
  }, [open, project?.stack]);

  const save = async () => {
    setSaving(true);
    try {
      await update(project.id, { stack: choice });
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
      description="Choose the stack the recreated site is generated in. Saved per project."
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
      {error && <p className={styles.error}>{error}</p>}
    </Modal>
  );
}
