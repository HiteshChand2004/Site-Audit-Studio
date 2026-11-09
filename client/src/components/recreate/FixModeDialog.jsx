import { useEffect, useState } from 'react';
import Modal from '../common/Modal.jsx';
import Button from '../common/Button.jsx';
import { Alert } from '../common/Surface.jsx';
import { api } from '../../api/client.js';
import { FIX_MODE as T } from '../../copy.js';

/**
 * Fix mode (Step 11) in "Copy my site": every proposed change with its exact change in words and its before / after
 * pictures at phone and computer width. Nothing is ticked at first; only the ticked ones are sent (`onApply(ids)`).
 */
export default function FixModeDialog({ open, projectId, recreateId, onApply, onClose }) {
  const [data, setData] = useState(null);
  const [state, setState] = useState('idle'); // loading | pictures | ready | error
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
        let d = await api.getFixProposals(projectId, recreateId);
        if (gone) return;
        setData(d);
        if (d.proposals.length && !d.pictures) {
          setState('pictures');
          d = await api.makeFixPictures(projectId, recreateId);
          if (gone) return;
          setData(d);
        }
        setState('ready');
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
      await onApply([...chosen]);
    } catch (err) {
      setError(err.message || 'Cannot reach the server.');
    } finally {
      setSaving(false);
    }
  }
  const lookOf = (p, width) => data?.looks?.find((l) => l.id === p.id && l.width === width);
  const picture = (file) => (file ? api.fixPictureUrl(projectId, recreateId, file) : null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={760}
      title={T.title}
      description={T.text}
      footer={
        <div style={{ display: 'flex', flexWrap: 'wrap-reverse', justifyContent: 'flex-end', gap: 'var(--sp-2)', width: '100%' }}>
          <Button onClick={onClose} disabled={saving}>{T.cancel}</Button>
          <Button variant="primary" onClick={apply} disabled={saving || !chosen.size || state !== 'ready'}>{T.apply(chosen.size)}</Button>
        </div>
      }
    >
      {state === 'loading' && <p style={{ margin: 0 }}>{T.loading}</p>}
      {state === 'pictures' && <p style={{ margin: 0 }}>{T.pictures}</p>}
      {error && <Alert tone="bad" title={T.failedTitle}>{error}</Alert>}
      {state === 'ready' && data && !data.proposals.length && <p style={{ margin: 0 }}>{T.none}</p>}
      {state === 'ready' && data?.proposals?.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--sp-4)' }}>
          {data.proposals.map((p) => (
            <li key={p.id} style={{ borderTop: '1px solid var(--hairline)', paddingTop: 'var(--sp-3)' }}>
              <label style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} style={{ marginTop: 4 }} />
                <span>
                  <strong>{T.kinds[p.kind] ?? p.kind}</strong> on <span className="mono">{p.page}</span>: <span className="mono">{p.text}</span>
                </span>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}>
                {(data.pictures?.[p.id] ?? []).map((v) => (
                  <figure key={v.width} style={{ margin: 0 }}>
                    <figcaption style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-2)' }}>
                      {v.width < 600 ? 'Phone' : 'Computer'} ({v.width} px){lookOf(p, v.width) ? ` · ${T.look(lookOf(p, v.width).changedPx)}` : ''}
                    </figcaption>
                    {v.missing ? (
                      <p style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>{T.notShown}</p>
                    ) : (
                      <div style={{ display: 'grid', gap: 4 }}>
                        <span style={{ fontSize: 'var(--fs-sm)' }}>{T.before}</span>
                        <img src={picture(v.before)} alt={`${p.page} at ${v.width} px now`} style={{ maxWidth: '100%', border: '1px solid var(--hairline)' }} />
                        <span style={{ fontSize: 'var(--fs-sm)' }}>{T.after}</span>
                        <img src={picture(v.after)} alt={`${p.page} at ${v.width} px with the change`} style={{ maxWidth: '100%', border: '1px solid var(--hairline)' }} />
                      </div>
                    )}
                  </figure>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {state === 'ready' && data?.skipped?.length > 0 && <p style={{ margin: 'var(--sp-3) 0 0', fontSize: 'var(--fs-sm)' }}>{T.skipped(data.skipped.length)}</p>}
    </Modal>
  );
}
