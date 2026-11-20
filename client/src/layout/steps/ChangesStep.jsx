import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleCheck, CircleX, ExternalLink, Inbox, Loader2, Minus, Rocket, X } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import Badge from '../../components/common/Badge.jsx';
import { Alert, Card, EmptyState } from '../../components/common/Surface.jsx';
import form from '../../components/common/Form.module.css';
import { CHANGES as T } from '../../copy.js';
import { timeAgo } from '../../format.js';
import { api } from '../../api/client.js';
import { apiUrl } from '../../api/base.js';
import panel from '../Panel.module.css';
import styles from './ChangesStep.module.css';

const BUSY = new Set(['received', 'building', 'publishing']);
const Spin = (p) => <Loader2 {...p} className={panel.spin} />;

/** One check, before → after. */
function Mark({ value }) {
  if (value === true) return <Check size={15} className={styles.pass} aria-label="passes" />;
  if (value === false) return <X size={15} className={styles.fail} aria-label="fails" />;
  return <Minus size={15} className={styles.none} aria-label="not measured" />;
}

function Score({ score }) {
  if (!score || score.after == null) return null;
  const delta = score.before == null ? null : score.after - score.before;
  return (
    <p className={styles.score}>
      <span className={styles.scoreLabel}>{T.score}</span>
      <span className="tabular">{score.before == null ? T.newPage : score.before}</span>
      <span aria-hidden="true">→</span>
      <strong className="tabular">{score.after}</strong>
      {delta != null && <Badge tone={delta > 0 ? 'ok' : delta < 0 ? 'bad' : 'neutral'}>{delta > 0 ? `+${delta}` : delta}</Badge>}
    </p>
  );
}

/** One change from Growth OS: what it is, how it was checked, and the person's decision. */
function ChangeCard({ projectId, change, onChanged }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const status = T.status[change.status] ?? { label: change.status, tone: 'neutral' };
  const what = change.draft?.h1 || change.draft?.title || T.fixLine(change);
  const decide = async (fn) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
      setAsking(false);
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };
  const shot = (name) => apiUrl(`/projects/${projectId}/changes/${change.id}/shots/${name}.webp`);
  return (
    <article className={styles.change}>
      <header className={styles.changeHead}>
        <div className={styles.changeTitles}>
          <p className={styles.kind}>{T.types[change.type] ?? change.type} · <span className="mono">{change.page === '*' ? T.everyPage : change.page}</span></p>
          <h3 className={styles.what}>{what}</h3>
          {change.context?.searches?.length > 0 && <p className={styles.sub}>{T.forSearch(change.context.searches[0])}</p>}
          {change.context?.insight && <p className={styles.sub}>{change.context.insight}</p>}
        </div>
        <div className={styles.changeSide}>
          <Badge tone={status.tone} dot>{BUSY.has(change.status) && <Spin size={12} />} {change.step || status.label}</Badge>
          <span className={styles.when}>{timeAgo(change.updatedAt)}</span>
        </div>
      </header>

      {change.message && <Alert tone={change.status === 'failed' || change.status === 'rejected' ? 'bad' : 'warn'}>{change.message}</Alert>}

      {(change.template || change.by || change.design) && (
        <p className={styles.made}>
          {T.madeBy(change)}
          {change.design && <> · {T.designLine(change.design)}</>}
        </p>
      )}

      {change.score && <Score score={change.score} />}

      {change.checks?.length > 0 && (
        <table className={styles.checks}>
          <thead>
            <tr><th scope="col">{T.check}</th><th scope="col">{T.before}</th><th scope="col">{T.after}</th></tr>
          </thead>
          <tbody>
            {change.checks.map((c) => (
              <tr key={c.id}>
                <td>{c.label}{c.detail && <span className={styles.detail}> · {c.detail}</span>}</td>
                <td><Mark value={c.before} /></td>
                <td><Mark value={c.after} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {change.shots && (
        <div className={styles.shots}>
          {change.shots.desktop && <figure><img src={shot('desktop')} alt={T.shotAlt('computer', change.page)} loading="lazy" /><figcaption>{T.computer}</figcaption></figure>}
          {change.shots.phone && <figure className={styles.phone}><img src={shot('phone')} alt={T.shotAlt('phone', change.page)} loading="lazy" /><figcaption>{T.phone}</figcaption></figure>}
        </div>
      )}

      {change.notes?.length > 0 && (
        <ul className={styles.notes}>
          {change.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}

      {error && <Alert tone="bad">{error}</Alert>}

      <div className={styles.actions}>
        {change.previewUrl && change.status !== 'published' && (
          <a className={styles.link} href={change.previewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true" /> {T.openPreview}</a>
        )}
        {change.liveUrl && (
          <a className={styles.link} href={change.liveUrl} target="_blank" rel="noopener noreferrer"><Rocket size={15} aria-hidden="true" /> {T.openLive}</a>
        )}
        {change.status === 'ready' && !asking && (
          <>
            <Button variant="primary" icon={CircleCheck} disabled={working} onClick={() => decide(() => api.approveChange(projectId, change.id))}>{T.approve}</Button>
            <Button variant="ghost" icon={CircleX} disabled={working} onClick={() => setAsking(true)}>{T.reject}</Button>
          </>
        )}
      </div>
      {asking && (
        <form className={styles.reject} onSubmit={(e) => { e.preventDefault(); decide(() => api.rejectChange(projectId, change.id, reason)); }}>
          <label className={form.label} htmlFor={`why-${change.id}`}>{T.rejectWhy}</label>
          <input id={`why-${change.id}`} className={form.input} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={T.rejectPlaceholder} />
          <div className={styles.actions}>
            <Button type="submit" variant="danger" disabled={working}>{T.rejectConfirm}</Button>
            <Button variant="ghost" onClick={() => setAsking(false)}>{T.keep}</Button>
          </div>
        </form>
      )}
    </article>
  );
}

/** The Changes section: what Growth OS asked for this website, each checked, waiting for a person's yes before it goes live. */
export default function ChangesStep({ project }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const gone = useRef(false);
  const load = useCallback(async () => {
    try {
      const d = await api.getChanges(project.id);
      if (!gone.current) {
        setData(d);
        setLoadError(null);
      }
    } catch (err) {
      if (!gone.current) setLoadError(err.message);
    }
  }, [project.id]);

  useEffect(() => {
    gone.current = false;
    setData(null);
    load();
    return () => { gone.current = true; };
  }, [load]);

  // Faster while something is being made or going live.
  const busy = data?.changes?.some((c) => BUSY.has(c.status));
  useEffect(() => {
    const t = setInterval(load, busy ? 2000 : 10000);
    return () => clearInterval(t);
  }, [load, busy]);

  const changes = data?.changes ?? [];
  const waiting = changes.filter((c) => c.status === 'ready').length;
  const link = data?.link;
  return (
    <div className={styles.wrap}>
      <Card icon={Inbox} title={T.title} sub={T.sub}>
        {loadError && <Alert tone="bad">{loadError}</Alert>}
        {link && !link.key && <Alert tone="warn" title={T.notLinkedTitle}>{T.notLinked}</Alert>}
        {link?.key && !link.secret && <Alert tone="warn">{T.noSecret}</Alert>}
        {data && (
          <p className={styles.where}>
            {T.whereLive(data.target)}
            {waiting > 0 && <> · <strong>{T.waiting(waiting)}</strong></>}
          </p>
        )}
      </Card>
      {data && !data.ready && <Alert tone="warn">{T.notReady}</Alert>}
      {data && data.ready && changes.length === 0 && (
        <EmptyState icon={Inbox} title={T.emptyTitle}>{T.empty}</EmptyState>
      )}
      {changes.map((c) => <ChangeCard key={c.id} projectId={project.id} change={c} onChanged={load} />)}
    </div>
  );
}
