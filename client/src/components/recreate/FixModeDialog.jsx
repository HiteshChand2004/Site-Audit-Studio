import { useEffect, useState } from 'react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { Alert } from '../common/Surface.jsx';
import { api } from '../../api/client.js';
import { FIX_MODE as T } from '../../copy.js';
import styles from './FixModeDialog.module.css';

/** The visible words of an element's markup as the check quoted it ("<p class=x>Prices include…</p>" → "Prices include…"). */
export function sampleText(snippet, max = 70) {
  const text = String(snippet ?? '')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Sample text';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The same change wherever it is (server copy/fixMode.js groupKey): one row, one tick, every place it applies to. */
export const groupKey = (p) => (p.kind === 'contrast'
  ? `contrast|${p.change.from}|${p.change.to}|${p.change.background}`
  : `${p.kind}|${p.selector}|${p.change.from}|${p.change.to}`);

/** Proposals as rows: `{ key, first, ids, pages }`, in the order the first of each was proposed. */
export function groupProposals(proposals) {
  const out = new Map();
  for (const p of proposals ?? []) {
    const key = groupKey(p);
    const g = out.get(key) ?? { key, first: p, items: [], ids: [], pages: [] };
    g.items.push(p);
    g.ids.push(p.id);
    if (!g.pages.includes(p.page)) g.pages.push(p.page);
    out.set(key, g);
  }
  return [...out.values()];
}

/** The text drawn in a colour on its background, with how readable that is. */
function Swatch({ label, color, background, sample, verdict, tone }) {
  return (
    <div className={styles.swatch}>
      <span className={styles.swatchLabel}>{label}</span>
      <div className={styles.swatchBox} style={{ color, background }}>
        {sample}
      </div>
      <span className={styles.verdict} data-tone={tone}>
        {verdict}
      </span>
      <span className={`mono ${styles.hex}`}>{String(color).toUpperCase()}</span>
    </div>
  );
}

/** One proposal's pictures on the page (phone and computer, now and after), once they are made. */
function Pictures({ group, pictures, projectId, recreateId }) {
  const p = group.items.find((x) => pictures?.[x.id]?.length) ?? group.first;
  const list = pictures?.[p.id] ?? [];
  if (!list.length) return null;
  const url = (file) => api.fixPictureUrl(projectId, recreateId, file);
  return (
    <details className={styles.where}>
      <summary>{T.where}{group.items.length > 1 ? ` (${p.page})` : ''}</summary>
      <div className={styles.pictures}>
        {list.map((v) => (
          <figure key={v.width} className={styles.figure}>
            <figcaption>{v.width < 600 ? T.phone : T.computer} ({v.width} px)</figcaption>
            {v.missing ? (
              <p className={styles.small}>{T.notShown}</p>
            ) : (
              <>
                <span className={styles.small}>{T.now}</span>
                <img src={url(v.before)} alt={`${p.page} at ${v.width} px now`} loading="lazy" />
                {v.after && (
                  <>
                    <span className={styles.small}>{T.after}</span>
                    <img src={url(v.after)} alt={`${p.page} at ${v.width} px with the change`} loading="lazy" />
                  </>
                )}
              </>
            )}
          </figure>
        ))}
      </div>
    </details>
  );
}

/**
 * Fix mode: every change the copy proposes (a text colour too faint against what is behind it, a heading that skips a level),
 * shown at once as the colours themselves; the pictures of each change on its page follow when the server has made them (they
 * take minutes, so nobody waits for them). Nothing is ticked at first; only the ticked ones are sent (`onApply(ids)`).
 */
export default function FixModeDialog({ open, projectId, recreateId, onApply, onClose }) {
  const [data, setData] = useState(null);
  const [state, setState] = useState('idle'); // loading | ready | error
  const [pictures, setPictures] = useState('idle'); // making | ready | failed
  const [error, setError] = useState(null);
  const [chosen, setChosen] = useState(() => new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let gone = false;
    setChosen(new Set());
    setError(null);
    setState('loading');
    (async () => {
      try {
        const d = await api.getFixProposals(projectId, recreateId);
        if (gone) return;
        setData(d);
        setState('ready');
        if (!d.proposals.length || d.pictures) {
          setPictures(d.pictures ? 'ready' : 'idle');
          return;
        }
        setPictures('making');
        try {
          const withPictures = await api.makeFixPictures(projectId, recreateId);
          if (gone) return;
          setData((cur) => ({ ...(cur ?? withPictures), pictures: withPictures.pictures, looks: withPictures.looks }));
          setPictures('ready');
        } catch {
          if (!gone) setPictures('failed');
        }
      } catch (err) {
        if (!gone) {
          setError(err.message || 'Cannot reach the server.');
          setState('error');
        }
      }
    })();
    return () => {
      gone = true;
    };
  }, [open, projectId, recreateId]);

  const proposals = data?.proposals ?? [];
  const groups = groupProposals(proposals);
  const chosenGroups = groups.filter((g) => chosen.has(g.key));
  const chosenIds = chosenGroups.flatMap((g) => g.ids);
  const toggle = (id) => setChosen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  async function apply() {
    setSaving(true);
    setError(null);
    try {
      await onApply(chosenIds);
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
      width={760}
      title={T.dialogTitle}
      description={T.dialogText}
      footer={
        <div className={styles.footer}>
          <Button onClick={onClose} disabled={saving}>{T.close}</Button>
          <Button variant="primary" onClick={apply} disabled={saving || !chosen.size || state !== 'ready'}>{T.apply(chosenGroups.length, chosenIds.length)}</Button>
        </div>
      }
    >
      {state === 'loading' && <p className={styles.plain}>{T.loading}</p>}
      {error && <Alert tone="bad" title={T.failedTitle}>{error}</Alert>}
      {state === 'ready' && !proposals.length && <p className={styles.plain}>{T.none}</p>}
      {state === 'ready' && proposals.length > 0 && (
        <>
          <div className={styles.toolbar}>
            <span className={styles.small}>{T.chosen(chosenGroups.length, groups.length)}</span>
            <Button size="sm" onClick={() => setChosen(new Set(groups.map((g) => g.key)))} disabled={chosenGroups.length === groups.length}>{T.selectAll}</Button>
            <Button size="sm" onClick={() => setChosen(new Set())} disabled={!chosen.size}>{T.clear}</Button>
          </div>
          {pictures === 'making' && <p className={styles.note}>{T.pictures}</p>}
          {pictures === 'failed' && <p className={styles.note}>{T.picturesFailed}</p>}
          <ul className={styles.list}>
            {groups.map((g) => {
              const p = g.first;
              return (
                <li key={g.key} className={styles.item} data-chosen={chosen.has(g.key) || undefined}>
                  <label className={styles.pick}>
                    <input type="checkbox" checked={chosen.has(g.key)} onChange={() => toggle(g.key)} />
                    <span>
                      <strong>{T.kinds[p.kind] ?? p.kind}</strong>
                      <span className={styles.page}>
                        {' · '}
                        {g.items.length === 1 ? <>on <span className="mono">{p.page}</span></> : T.places(g.items.length, g.pages.length)}
                      </span>
                    </span>
                  </label>
                  {p.kind === 'contrast' ? (
                    <>
                      <div className={styles.swatches}>
                        <Swatch label={T.now} color={p.change.from} background={p.change.background} sample={sampleText(p.snippet)} verdict={T.hard(p.before?.ratio)} tone="bad" />
                        <Swatch label={T.after} color={p.change.to} background={p.change.background} sample={sampleText(p.snippet)} verdict={T.easy(p.after?.ratio)} tone="ok" />
                      </div>
                      <p className={styles.small}>{T.needs(p.needs)}</p>
                    </>
                  ) : (
                    <p className={styles.small}>
                      {sampleText(p.snippet) !== 'Sample text' && <>“{sampleText(p.snippet)}”: </>}
                      {T.heading(p.change.from, p.change.to)}
                    </p>
                  )}
                  {g.pages.length > 1 && (
                    <details className={styles.where}>
                      <summary>{g.pages.length} pages</summary>
                      <p className={`mono ${styles.small} ${styles.pageList}`}>{g.pages.join('  ·  ')}</p>
                    </details>
                  )}
                  <Pictures group={g} pictures={data.pictures} projectId={projectId} recreateId={recreateId} />
                </li>
              );
            })}
          </ul>
        </>
      )}
      {state === 'ready' && data?.skipped?.length > 0 && <p className={styles.note}>{T.skipped(data.skipped.length)}</p>}
    </Modal>
  );
}
