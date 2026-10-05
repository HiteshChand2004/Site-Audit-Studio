import { useState } from 'react';
import Button from './Button.jsx';
import Modal from './Modal.jsx';

/**
 * A yes/no question in the app's own dialog (instead of the browser's confirm box).
 * onConfirm may be async; the buttons wait for it.
 */
export default function ConfirmDialog({ open, onClose, title, children, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'dangerSolid' : 'primary'} onClick={confirm} disabled={busy}>
            {busy ? 'Please wait…' : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
