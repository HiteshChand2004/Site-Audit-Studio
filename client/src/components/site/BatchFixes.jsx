// Home: "Apply the latest fixes" to every website that has an original (as-is) copy, several at once (POST /api/batch-fixes;
// the server keeps one of the account's job slots free and starts each site the way its own button does). Shown only when a
// site has such a copy or a batch exists. Polls while it runs; each site's jobs are followed by the store, so the sidebar moves.
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Square } from 'lucide-react';
import { api } from '../../api/client.js';
import Button from '../common/Button.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import { Alert, Card } from '../common/Surface.jsx';
import { BATCH_FIXES } from '../../copy.js';
import { useProjects } from '../../store/useProjects.js';
import styles from './BatchFixes.module.css';

const POLL_MS = 5000;
const isActive = (b) => Boolean(b && !b.finishedAt);
const ORDER = ['running', 'waiting', 'done', 'failed', 'skipped', 'not-started'];

export default function BatchFixes() {
  const projects = useProjects((s) => s.projects);
  const overviews = useProjects((s) => s.overviews);
  const [batch, setBatch] = useState(null);
  const [error, setError] = useState(null);
  const [asking, setAsking] = useState(false);
  const seen = useRef(new Map()); // projectId -> last state, to follow a site's job once it starts and reload it once it ends
  const eligible = projects.filter((p) => overviews[p.id]?.recreate?.result?.asIs);

  const take = (b) => {
    setBatch(b);
    const store = useProjects.getState();
    for (const s of b?.sites ?? []) {
      const before = seen.current.get(s.projectId);
      if (s.state === 'running' && before !== 'running') store.followJobs(s.projectId);
      if (before === 'running' && s.state !== 'running') store.loadOverview(s.projectId);
      seen.current.set(s.projectId, s.state);
    }
  };

  useEffect(() => { api.getBatchFixes().then((r) => take(r?.batch ?? null)).catch(() => {}); }, []);
  const running = isActive(batch);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => { api.getBatchFixes().then((r) => take(r?.batch ?? null)).catch(() => {}); }, POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const start = async () => {
    setError(null);
    try { take((await api.startBatchFixes({ projectIds: eligible.map((p) => p.id) })).batch); }
    catch (err) { setError(err.message); }
  };
  const stop = async () => {
    try { take((await api.stopBatchFixes()).batch); } catch (err) { setError(err.message); }
  };

  if (!eligible.length && !batch) return null;
  const counts = ORDER.map((st) => [st, (batch?.sites ?? []).filter((s) => s.state === st).length]).filter(([, n]) => n);
  return (
    <Card
      icon={RefreshCw}
      title={BATCH_FIXES.title}
      sub={BATCH_FIXES.sub}
      actions={running
        ? <Button icon={Square} onClick={stop} disabled={batch.stopped}>{batch.stopped ? 'Stopping…' : 'Stop'}</Button>
        : <Button variant="primary" icon={RefreshCw} disabled={!eligible.length} onClick={() => setAsking(true)}>Apply to {eligible.length} {eligible.length === 1 ? 'site' : 'sites'}</Button>}
    >
      {error && <Alert tone="bad">{error}</Alert>}
      {batch && (
        <>
          <p className={styles.counts}>
            {counts.map(([st, n]) => `${n} ${BATCH_FIXES.states[st].toLowerCase()}`).join(' · ')}
            {batch.finishedAt && ' · finished'}
          </p>
          <ul className={styles.sites}>
            {batch.sites.map((s) => (
              <li key={s.projectId} data-state={s.state}>
                <span className={styles.name}>{s.name}</span>
                <span className={styles.state}>{BATCH_FIXES.states[s.state] ?? s.state}{s.reason ? `: ${s.reason}` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <ConfirmDialog open={asking} onClose={() => setAsking(false)} title={BATCH_FIXES.title} confirmLabel="Apply the fixes" onConfirm={start}>
        {BATCH_FIXES.confirm(eligible.length)}
      </ConfirmDialog>
    </Card>
  );
}
