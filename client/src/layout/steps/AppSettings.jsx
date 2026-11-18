import { useRef, useState } from 'react';
import { FileUp, Loader2, Plus, X } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import { Alert } from '../../components/common/Surface.jsx';
import form from '../../components/common/Form.module.css';
import { GO_LIVE as T } from '../../copy.js';
import { parseEnvText, SETTING_NAME } from '../../envText.js';
import ws from '../Workspace.module.css';
import panel from '../Panel.module.css';
import styles from './GoLiveStep.module.css';

const Spin = (p) => <Loader2 {...p} className={panel.spin} />;
// An imported .env larger than this is not a settings file.
const IMPORT_MAX_BYTES = 512 * 1024;
let nextId = 0;
const blankRow = () => ({ id: (nextId += 1), key: '', value: '' });

/**
 * The app's settings as Key / Value rows (like a hosting dashboard's environment variables): a row for every setting the code
 * reads, then rows the person adds for anything else. A whole .env pasted into a Key box, or imported as a file, fills the rows
 * at once. A saved value is never shown again: its row says it is set, and Change types a new one.
 * @param {{ app: any, busy: boolean, onSave: (values: Record<string, string>) => Promise<boolean>, onRemove: (name: string) => void }} props
 *   app: the card's app state; onSave resolves true when saved
 */
export default function AppSettings({ app, busy, onSave, onRemove }) {
  const code = app.app?.settings ?? [];
  const codeNames = new Set(code.map((s) => s.name));
  const isSet = (name) => app.settingsSet.includes(name);
  // Values typed for the code's settings (and set ones being changed), by name.
  const [values, setValues] = useState({});
  const [changing, setChanging] = useState(() => new Set());
  // Rows the person added: any other setting, by name.
  const [extra, setExtra] = useState(() => [blankRow()]);
  const [note, setNote] = useState(null);
  const fileRef = useRef(null);

  const setValue = (name, v) => setValues((m) => ({ ...m, [name]: v }));
  const setExtraRow = (id, patch) => setExtra((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /** Lines of a .env into the rows: the code's own settings into theirs (a set one is changed), the rest as rows of their own. */
  function spread(text) {
    const pairs = parseEnvText(text);
    if (!pairs.length) return false;
    const own = pairs.filter(([k]) => codeNames.has(k));
    const others = pairs.filter(([k]) => !codeNames.has(k));
    setValues((m) => ({ ...m, ...Object.fromEntries(own) }));
    setChanging((s) => new Set([...s, ...own.filter(([k]) => isSet(k)).map(([k]) => k)]));
    setExtra((rows) => {
      const kept = rows.filter((r) => r.key.trim() || r.value);
      const byKey = new Map(kept.map((r) => [r.key.trim(), r]));
      for (const [k, v] of others) byKey.set(k, { ...(byKey.get(k) ?? blankRow()), key: k, value: v });
      return [...byKey.values(), blankRow()];
    });
    const empty = pairs.filter(([, v]) => v === '').map(([k]) => k);
    setNote({ count: pairs.length, empty });
    return true;
  }
  function pasteIntoKey(e) {
    const text = e.clipboardData.getData('text');
    if (text.includes('=') && spread(text)) e.preventDefault();
  }
  async function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) return setNote({ error: T.envTooLarge });
    if (!spread(await file.text())) setNote({ error: T.envNothing });
  }

  // What Save sends: every filled value; an added row needs a valid name.
  const filled = Object.entries(values).map(([k, v]) => [k, v.trim() ? v : '']).filter(([k, v]) => v && (!isSet(k) || changing.has(k)));
  const added = extra.filter((r) => r.key.trim() && r.value.trim());
  const badNames = extra.map((r) => r.key.trim()).filter((k) => k && !SETTING_NAME.test(k));
  const toSave = Object.fromEntries([...filled, ...added.map((r) => [r.key.trim(), r.value])]);
  async function save() {
    if (await onSave(toSave)) {
      setValues({});
      setChanging(new Set());
      setExtra([blankRow()]);
      setNote(null);
    }
  }

  /** A value box: one line to start with, as tall as what is in it (a private key), up to a few lines. */
  const valueBox = (value, onChange, label, placeholder) => (
    <textarea className={`${form.input} ${styles.envValue}`} rows={Math.min(6, Math.max(1, value.split('\n').length))} value={value}
      onChange={(e) => onChange(e.target.value)} disabled={busy} aria-label={label} placeholder={placeholder} autoComplete="off" spellCheck={false} />
  );

  // The code's settings, then the set ones the code was not seen reading.
  const rows = [...code, ...(app.unused ?? []).map((name) => ({ name, unused: true }))];
  return (
    <div className={styles.envTable}>
      <div className={`${styles.envRow} ${styles.envHead}`} aria-hidden="true">
        <span>{T.envKey}</span><span>{T.envValue}</span><span />
      </div>
      {rows.map((s) => {
        const set = isSet(s.name);
        const editing = !set || changing.has(s.name);
        const stopped = app.stoppedFor?.includes(s.name);
        return (
          <div key={s.name} className={styles.envRow}>
            <div>
              <code className={styles.envName}>{s.name}</code>
              {s.example && <span className={styles.found}>{T.appSettingExample(s.example)}</span>}
            </div>
            <div>
              {editing ? valueBox(values[s.name] ?? '', (v) => setValue(s.name, v), T.appSettingValue(s.name), set ? T.envNewValue : '') : (
                <span className={styles.envHidden}>{T.envHidden}</span>
              )}
            </div>
            <div className={styles.envActions}>
              <span className={styles.badge} data-status={s.unused ? undefined : set ? 'ready' : stopped ? 'failed' : undefined}>
                {s.unused ? T.appSettingUnused : set ? T.appSettingSet : T.appSettingMissing}
              </span>
              {set && !changing.has(s.name) && (
                <button type="button" className={styles.copy} disabled={busy} onClick={() => setChanging((c) => new Set([...c, s.name]))}>{T.envChange}</button>
              )}
              {set && changing.has(s.name) && (
                <button type="button" className={styles.copy} disabled={busy} onClick={() => {
                  setChanging((c) => new Set([...c].filter((n) => n !== s.name)));
                  setValue(s.name, '');
                }}>{T.envKeep}</button>
              )}
              {set && <button type="button" className={styles.copy} disabled={busy} onClick={() => onRemove(s.name)}>{T.appSettingRemove}</button>}
            </div>
          </div>
        );
      })}

      {extra.map((r, i) => (
        <div key={r.id} className={styles.envRow}>
          <div>
            <input className={`${form.input} ${styles.envName}`} value={r.key} disabled={busy} placeholder={i === extra.length - 1 ? T.envKeyPlaceholder : ''}
              aria-label={T.envKey} autoComplete="off" spellCheck={false} onPaste={pasteIntoKey}
              onChange={(e) => setExtraRow(r.id, { key: e.target.value })} aria-invalid={Boolean(r.key.trim() && !SETTING_NAME.test(r.key.trim()))} />
            {codeNames.has(r.key.trim()) && <span className={styles.found}>{T.envDuplicate}</span>}
          </div>
          <div>{valueBox(r.value, (v) => setExtraRow(r.id, { value: v }), T.appSettingValue(r.key.trim() || T.envNewSetting), '')}</div>
          <div className={styles.envActions}>
            {(extra.length > 1 || r.key || r.value) && (
              <button type="button" className={styles.iconButton} disabled={busy} aria-label={T.envRemoveRow}
                onClick={() => setExtra((rows) => (rows.length > 1 ? rows.filter((x) => x.id !== r.id) : [blankRow()]))}><X size={14} aria-hidden="true" /></button>
            )}
          </div>
        </div>
      ))}

      <div className={styles.accountButtons} style={{ alignItems: 'center' }}>
        <Button size="sm" icon={Plus} disabled={busy} onClick={() => setExtra((rows) => [...rows, blankRow()])}>{T.envAdd}</Button>
        <Button size="sm" icon={FileUp} disabled={busy} onClick={() => fileRef.current?.click()}>{T.envImport}</Button>
        <input ref={fileRef} type="file" hidden onChange={importFile} />
        <span className={ws.hint} style={{ margin: 0 }}>{T.envPasteHint}</span>
      </div>
      {badNames.length > 0 && <Alert tone="bad" title="Check this">{T.envBadNames(badNames)}</Alert>}
      {note && (note.error ? <Alert tone="bad" title="Not done">{note.error}</Alert> : (
        <Alert tone={note.empty.length ? 'warn' : 'ok'} title={T.envFilledTitle(note.count)}>{T.envFilled(note)}</Alert>
      ))}
      <div className={styles.accountButtons}>
        <Button size="sm" icon={busy ? Spin : undefined} disabled={busy || badNames.length > 0 || !Object.keys(toSave).length} onClick={save}>
          {Object.keys(toSave).length ? T.envSaveN(Object.keys(toSave).length) : T.appSettingsSave}
        </Button>
      </div>
    </div>
  );
}
