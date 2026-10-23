import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { BadgeCheck, ChevronsUpDown, KeyRound, LogOut } from 'lucide-react';
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

/** Up to two initials from the name (else the address's first letter), for the avatar. */
function initialsOf(user) {
  const words = String(user.name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = words.length ? words.slice(0, 2).map((w) => w[0]) : [String(user.email ?? '?')[0]];
  return letters.join('').toUpperCase();
}

function Avatar({ user, size = 'md' }) {
  return (
    <span className={styles.avatar} data-size={size} aria-hidden="true">
      {initialsOf(user)}
    </span>
  );
}

/**
 * The signed-in account at the foot of the sidebar: a profile button (initials, name, address) that opens a small menu —
 * who you are, Change password, Sign out. In the collapsed rail only the initials show; the menu opens beside them. The menu
 * floats above the page (the sidebar clips what overflows it), closes on Escape, a click outside or Tab, and is worked with
 * the arrow keys like any menu. Shows nothing when the API has no accounts (getMe → null), so the single-user tool is unchanged.
 */
export default function AccountMenu({ compact = false }) {
  const [user, setUser] = useState(null);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [place, setPlace] = useState(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const menuId = useId();

  useEffect(() => {
    let alive = true;
    api.getMe().then((u) => alive && setUser(u)).catch(() => {});
    return () => { alive = false; };
  }, []);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  // Where the menu goes: above the profile button in the sidebar, beside the initials in the rail.
  useLayoutEffect(() => {
    if (!open || !trigger.current) {
      setPlace(null);
      return;
    }
    const r = trigger.current.getBoundingClientRect();
    setPlace(compact
      ? { left: r.right + 10, bottom: Math.max(8, window.innerHeight - r.bottom) }
      : { left: r.left, bottom: window.innerHeight - r.top + 8, width: r.width });
  }, [open, compact]);

  // Once the menu is placed (it renders only then), its first item takes focus.
  useEffect(() => {
    if (open && place) menu.current?.querySelector('[role="menuitem"]')?.focus();
  }, [open, place]);

  // Open: a click outside or a resize closes the menu.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (!menu.current?.contains(e.target) && !trigger.current?.contains(e.target)) close(false);
    };
    const resize = () => close(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', resize);
    };
  }, [open, close]);

  if (!user) return null;

  const signOut = async () => {
    setLeaving(true);
    await api.signOut().catch(() => {});
    window.location.assign(`${SIGN_IN_URL}?mode=signin`);
  };

  const onMenuKey = (e) => {
    const items = [...(menu.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement);
    const go = (i) => items[(i + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') { e.preventDefault(); go(at + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(items.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  const label = user.name || user.email;

  return (
    <div className={styles.account} data-compact={compact || undefined}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={compact ? `Account: ${label}` : undefined}
        title={compact ? label : undefined}
        data-open={open || undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
        }}
      >
        <Avatar user={user} />
        {!compact && (
          <>
            <span className={styles.who}>
              <span className={styles.name}>{label}</span>
              {user.name && <span className={styles.email}>{user.email}</span>}
            </span>
            <ChevronsUpDown size={15} className={styles.chevron} aria-hidden="true" />
          </>
        )}
      </button>

      {open && place && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Account"
          className={styles.menu}
          data-side={compact ? 'right' : 'top'}
          style={{ left: place.left, bottom: place.bottom, ...(place.width && { width: Math.max(place.width, 248) }) }}
          onKeyDown={onMenuKey}
        >
          <div className={styles.head}>
            <Avatar user={user} size="lg" />
            <div className={styles.headText}>
              <p className={styles.headName}>{user.name || 'Your account'}</p>
              <p className={styles.headEmail} title={user.email}>{user.email}</p>
              <p className={styles.tags}>
                {user.role === 'owner' && <span className={styles.tag}>Owner</span>}
                {user.verified && (
                  <span className={styles.tag} data-kind="ok">
                    <BadgeCheck size={12} aria-hidden="true" /> Verified
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className={styles.items}>
            <button type="button" role="menuitem" className={styles.item} onClick={() => { close(false); setChanging(true); }}>
              <KeyRound size={16} aria-hidden="true" />
              <span>Change password</span>
            </button>
            <button type="button" role="menuitem" className={styles.item} data-kind="out" onClick={signOut} disabled={leaving}>
              <LogOut size={16} aria-hidden="true" />
              <span>{leaving ? 'Signing out…' : 'Sign out'}</span>
            </button>
          </div>
        </div>
      )}

      <ChangePasswordModal open={changing} onClose={() => { setChanging(false); trigger.current?.focus(); }} />
    </div>
  );
}
