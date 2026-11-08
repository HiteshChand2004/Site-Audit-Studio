import { useEffect, useState } from 'react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import form from '../common/Form.module.css';
import { ADDRESS_DIALOG as T } from '../../copy.js';

/**
 * Asked at download when a "Copy my site" copy has no new-site address. `onUse(address)` writes it (it throws the server's
 * reason, shown under the field); `onLater()` downloads the copy exactly as it is.
 */
export default function AddressDialog({ open, initial = '', onUse, onLater, onClose }) {
  const [address, setAddress] = useState(initial);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setAddress(initial);
      setError(null);
    }
  }, [open, initial]);

  async function submit(e) {
    e.preventDefault();
    if (!address.trim()) return setError(T.empty);
    setSaving(true);
    setError(null);
    try {
      await onUse(address.trim());
    } catch (err) {
      setError(err.message || 'Cannot reach the server.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={T.title}
      description={T.text}
      footer={
        // On a phone the two buttons do not fit side by side: they wrap, the main one first, nothing cut off.
        <div style={{ display: 'flex', flexWrap: 'wrap-reverse', justifyContent: 'flex-end', gap: 'var(--sp-2)', width: '100%' }}>
          <Button onClick={onLater} disabled={saving}>{T.later}</Button>
          <Button variant="primary" type="submit" form="sas-address-form" disabled={saving}>{T.use}</Button>
        </div>
      }
    >
      <form id="sas-address-form" className={form.form} onSubmit={submit} noValidate>
        <label className={form.field}>
          <span className={form.label}>{T.label}</span>
          <input
            className={form.input}
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder={T.placeholder}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby="sas-address-hint"
            autoFocus
          />
        </label>
        {error ? (
          <p className={form.error} role="alert" style={{ margin: 0 }}>{error}</p>
        ) : (
          <p id="sas-address-hint" className={form.label} style={{ margin: 0, fontWeight: 400 }}>{T.hint}</p>
        )}
      </form>
    </Modal>
  );
}
