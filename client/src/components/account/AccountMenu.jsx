import { useEffect, useState } from 'react';
import { KeyRound, LogOut, UserRound } from 'lucide-react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { api } from '../../api/client.js';
import { SIGN_IN_URL } from '../../api/base.js';
import form from '../common/Form.module.css';
import styles from './AccountMenu.module.css';

const EMPTY = { current: '', next: '', confirm: '' };

/** A new password: the current one first. The server ends every other session of the account (signed out elsewhere). */
function ChangePasswordModal({ open, onClose }) {
  const [values, setValues] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const close = () => {
    setValues(EMPTY);
    setError(null);
    setDone(false);
    onClose();
  };
  const set = (k) => (e) => setValues({ ...values, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (values.next !== values.confirm) return setError({ field: 'confirm', message: 'The new passwords do not match.' });
    setSaving(true);
    setError(null);
    try {
      await api.changePassword(values.current, values.next);
      setDone(true);
      setValues(EMPTY);
    } catch (err) {
      setError({ field: err.data?.field, message: err.message });
    } finally {
      setSaving(false);
    }
  };

  const field = (k, label, autoComplete, serverField) => (
    <label className={form.field}>
      <span className={form.label}>{label}</span>
      <input
        className={form.input}
        type="password"
        autoComplete={autoComplete}
        value={values[k]}
        onChange={set(k)}
        aria-invalid={error?.field === serverField || undefined}
        required
      />
    </label>
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title="Change password"
      description="Every other place you are signed in will be signed out."
      footer={
        done ? (
          <Button variant="primary" onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="change-password" disabled={saving || !values.current || !values.next || !values.confirm}>
              {saving ? 'Saving…' : 'Change password'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p role="status">Your password is changed. You stay signed in here.</p>
      ) : (
        <form id="change-password" className={form.form} onSubmit={submit}>
          {field('current', 'Current password', 'current-password', 'currentPassword')}
          {field('next', 'New password (8 characters or more)', 'new-password', 'newPassword')}
          {field('confirm', 'New password again', 'new-password', 'confirm')}
          {error && <p className={form.error} role="alert">{error.message}</p>}
        </form>
      )}
    </Modal>
  );
}

/**
 * The signed-in account at the foot of the sidebar: its name (the address when it has none; the address on hover), Change
 * password, Sign out. Shows nothing when the API runs
 * without accounts (getMe → null), so the single-user tool looks as it always did.
 */
export default function AccountMenu({ compact = false }) {
  const [user, setUser] = useState(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getMe().then((u) => alive && setUser(u)).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!user) return null;

  const signOut = async () => {
    await api.signOut().catch(() => {});
    window.location.assign(`${SIGN_IN_URL}?mode=signin`);
  };

  if (compact) {
    return (
      <div className={styles.rail}>
        <button type="button" className={styles.icon} title={`Signed in as ${user.name || user.email} — sign out`} aria-label={`Sign out ${user.name || user.email}`} onClick={signOut}>
          <LogOut size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className={styles.account}>
      <p className={styles.who} title={user.email}>
        <UserRound size={14} aria-hidden="true" />
        <span className={styles.email}>{user.name || user.email}</span>
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={() => setChanging(true)}>
          <KeyRound size={14} aria-hidden="true" /> Change password
        </button>
        <button type="button" className={styles.action} onClick={signOut}>
          <LogOut size={14} aria-hidden="true" /> Sign out
        </button>
      </div>
      <ChangePasswordModal open={changing} onClose={() => setChanging(false)} />
    </div>
  );
}
