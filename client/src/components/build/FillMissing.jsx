import { useState } from 'react';
import { Check } from 'lucide-react';
import Button from '../common/Button.jsx';
import { Card } from '../common/Surface.jsx';
import form from '../common/Form.module.css';
import { pageName } from './words.js';
import styles from './AfterBuild.module.css';

/** One gap the site still shows ([Phone]): typed in, it goes on every page that shows it. */
function Gap({ gap, onFill }) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const id = `fill-${gap.token}`;
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onFill(gap.token, value);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  return (
    <li className={styles.gap}>
      <label className={styles.gapLabel} htmlFor={id}>
        {gap.label}
        <span className={styles.where}>Shown on {gap.pages.map(pageName).join(', ')}</span>
      </label>
      {gap.fillable ? (
        <form className={styles.gapForm} onSubmit={save}>
          <input id={id} className={form.input} value={value} maxLength={500} onChange={(e) => setValue(e.target.value)} placeholder={`Your ${gap.label.toLowerCase()}`} aria-invalid={Boolean(error) || undefined} />
          <Button type="submit" variant="primary" icon={Check} disabled={saving || !value.trim()}>{saving ? 'Saving…' : 'Put it on the site'}</Button>
        </form>
      ) : (
        <p className={styles.note}>This one is put together by the site’s code, so it changes only with a new build.</p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </li>
  );
}

/** The site's marked gaps, and the facts the build said are missing that are not marked on a page. */
export default function FillMissing({ texts, onFill }) {
  const { placeholders, notMarked } = texts;
  if (!placeholders.length && !notMarked.length) return null;
  return (
    <Card title="Fill in what’s missing" sub="The site shows these as marked gaps for now. Type each one in and it goes on every page that shows it, in seconds.">
      {placeholders.length > 0 && <ul className={styles.gaps}>{placeholders.map((g) => <Gap key={g.token} gap={g} onFill={onFill} />)}</ul>}
      {notMarked.length > 0 && (
        <p className={styles.note}>Also still to add, though not marked on a page: {notMarked.join(' · ')}. Write them into the text below where they belong.</p>
      )}
    </Card>
  );
}
