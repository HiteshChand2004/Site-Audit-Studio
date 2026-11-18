import { useState } from 'react';
import { FileText, Loader2, Server, Terminal } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { Segmented } from '../../components/common/Tabs.jsx';
import { Alert } from '../../components/common/Surface.jsx';
import form from '../../components/common/Form.module.css';
import { GO_LIVE as T } from '../../copy.js';
import { api } from '../../api/client.js';
import ws from '../Workspace.module.css';
import panel from '../Panel.module.css';
import styles from './GoLiveStep.module.css';

const Spin = (p) => <Loader2 {...p} className={panel.spin} />;
const sourceKey = (s) => (s.kind === 'file' ? `f:${s.path}` : `p:${s.pid}`);

/**
 * "Copy settings from the old server": an optional way to fill the app's settings, next to typing or pasting them. The person
 * signs in to the server the website runs on now (SSH, key or password); Remastly lists its settings files and running programs
 * by name, and copies the chosen one's settings that the app's code reads. The login lives in this form only, sent with each of
 * the two asks, and is forgotten when the form closes.
 * @param {{ project: any, wanted: number, onCopied: (next: any) => void }} props  wanted: how many settings the code reads
 */
export default function OldServerImport({ project, wanted, onCopied }) {
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState(() => ({ host: hostOf(project.url), port: '22', username: '', password: '', privateKey: '', passphrase: '' }));
  const [withKey, setWithKey] = useState(true);
  const [found, setFound] = useState(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const field = (name) => ({ value: login[name], onChange: (e) => setLogin((l) => ({ ...l, [name]: e.target.value })), disabled: busy, autoComplete: 'off', spellCheck: false });
  // Only the way chosen is sent: a key typed and then switched away from never leaves the browser.
  const body = () => ({ host: login.host, port: login.port, username: login.username, ...(withKey ? { privateKey: login.privateKey, passphrase: login.passphrase } : { password: login.password }) });
  const ready = login.host.trim() && login.username.trim() && (withKey ? login.privateKey.trim() : login.password);

  function close() {
    setOpen(false);
    setFound(null);
    setChoice('');
    setError(null);
    setLogin((l) => ({ ...l, password: '', privateKey: '', passphrase: '' }));
  }
  async function run(call) {
    setBusy(true);
    setError(null);
    try {
      return await call();
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function find() {
    const result = await run(() => api.findOldServerSettings(project.id, body()));
    if (!result) return;
    setFound(result);
    const best = result.sources.find((s) => s.readable);
    setChoice(best ? sourceKey(best) : '');
  }
  async function copy() {
    const source = found.sources.find((s) => sourceKey(s) === choice);
    const next = await run(() => api.copyOldServerSettings(project.id, { ...body(), source: source.kind === 'file' ? { kind: 'file', path: source.path } : { kind: 'program', pid: source.pid } }));
    if (!next) return;
    close();
    onCopied(next);
  }

  if (!open) {
    return (
      <div className={styles.accountButtons} style={{ alignItems: 'center' }}>
        <Button size="sm" icon={Server} onClick={() => setOpen(true)}>{T.oldOpen}</Button>
        <span className={ws.hint} style={{ margin: 0 }}>{T.oldOptional}</span>
      </div>
    );
  }

  return (
    <div className={styles.confirm}>
      <p className={styles.confirmTitle}>{T.oldTitle}</p>
      <p className={ws.hint} style={{ margin: 0 }}>{T.oldText}</p>
      {!found && (
        <form onSubmit={(e) => { e.preventDefault(); if (ready && !busy) find(); }} style={{ display: 'grid', gap: 'var(--sp-3)' }}>
          <div className={styles.godaddyFields}>
            <label className={form.field}>
              <span className={form.label}>{T.oldHost}</span>
              <input className={form.input} {...field('host')} placeholder="old.example.com" />
            </label>
            <label className={form.field}>
              <span className={form.label}>{T.oldUser}</span>
              <input className={form.input} {...field('username')} placeholder="ubuntu" />
            </label>
            <label className={form.field}>
              <span className={form.label}>{T.oldPort}</span>
              <input className={form.input} {...field('port')} inputMode="numeric" />
            </label>
          </div>
          <Segmented label={T.oldHow} size="sm" value={withKey ? 'key' : 'password'} onChange={(v) => setWithKey(v === 'key')}
            options={[{ value: 'key', label: T.oldWithKey }, { value: 'password', label: T.oldWithPassword }]} />
          {withKey ? (
            <>
              <label className={form.field}>
                <span className={form.label}>{T.oldKey}</span>
                <textarea className={form.input} rows={4} {...field('privateKey')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style={{ fontFamily: 'var(--font-mono, monospace)' }} />
              </label>
              <label className={form.field}>
                <span className={form.label}>{T.oldPassphrase}</span>
                <input className={form.input} type="password" {...field('passphrase')} />
              </label>
            </>
          ) : (
            <label className={form.field}>
              <span className={form.label}>{T.oldPassword}</span>
              <input className={form.input} type="password" {...field('password')} />
            </label>
          )}
          <p className={ws.hint} style={{ margin: 0 }}>{T.oldSafety}</p>
          <div className={styles.accountButtons}>
            <Button variant="primary" size="sm" type="submit" icon={busy ? Spin : undefined} disabled={busy || !ready}>{busy ? T.oldLooking : T.oldFind}</Button>
            <Button size="sm" disabled={busy} onClick={close}>{T.oldCancel}</Button>
          </div>
        </form>
      )}

      {found && (
        <>
          <p className={ws.hint} style={{ margin: 0 }}>{T.oldFound(found, login.host)}</p>
          {found.sources.length === 0 ? (
            <Alert tone="warn" title={T.oldNoneTitle}>{T.oldNone(found.sudo)}</Alert>
          ) : (
            <div role="radiogroup" aria-label={T.oldChoose} style={{ display: 'grid', gap: 'var(--sp-2)' }}>
              {found.sources.map((s) => (
                <label key={sourceKey(s)} className={styles.sourceItem} style={{ opacity: s.readable ? 1 : 0.6 }}>
                  <input type="radio" name="old-source" value={sourceKey(s)} checked={choice === sourceKey(s)} disabled={busy || !s.readable} onChange={() => setChoice(sourceKey(s))} />
                  <span>
                    {s.kind === 'file' ? <FileText size={14} aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}{' '}
                    <code>{s.kind === 'file' ? s.path : s.command}</code>
                    <span className={styles.found}>{s.readable ? T.oldMatches(s, wanted) : T.oldUnreadable(found.sudo)}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className={styles.accountButtons}>
            <Button variant="primary" size="sm" icon={busy ? Spin : undefined} disabled={busy || !choice} onClick={copy}>{T.oldCopy}</Button>
            <Button size="sm" disabled={busy} onClick={() => { setFound(null); setChoice(''); }}>{T.oldBack}</Button>
            <Button size="sm" disabled={busy} onClick={close}>{T.oldCancel}</Button>
          </div>
        </>
      )}
      {error && <Alert tone="bad" title={T.oldFailedTitle}>{error}</Alert>}
    </div>
  );
}

/** The website's own host name, the likely address of the server it runs on now. @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
