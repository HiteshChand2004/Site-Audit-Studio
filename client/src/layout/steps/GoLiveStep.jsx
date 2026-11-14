import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudUpload, ExternalLink, Globe, History, KeyRound, Link2, Loader2, Rocket, Unplug } from 'lucide-react';
import Button from '../../components/common/Button.jsx';
import Modal from '../../components/common/Modal.jsx';
import ConfirmDialog from '../../components/common/ConfirmDialog.jsx';
import StepList from '../../components/common/StepList.jsx';
import SectionCard from '../../components/common/SectionCard.jsx';
import { Alert, Card, EmptyState } from '../../components/common/Surface.jsx';
import form from '../../components/common/Form.module.css';
import { stackById } from '../../constants.js';
import { GO_LIVE as T } from '../../copy.js';
import { timeAgo } from '../../format.js';
import { api } from '../../api/client.js';
import ws from '../Workspace.module.css';
import panel from '../Panel.module.css';
import styles from './GoLiveStep.module.css';

const STEP_ORDER = ['package', 'site', 'upload', 'publish'];
const POLL_MS = 1500;
const isRunning = (d) => d && (d.status === 'queued' || d.status === 'running');
const Spin = (p) => <Loader2 {...p} className={panel.spin} />;

function size(bytes) {
  if (!Number.isFinite(bytes)) return 'size unknown';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Step 5: connect Netlify once, then publish the latest copy and update it after every new one. */
export default function GoLiveStep({ project, onGoCreate }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [asking, setAsking] = useState(false);
  const [askDisconnect, setAskDisconnect] = useState(false);
  const [accepted, setAccepted] = useState(() => new Set());
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const gone = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getDeploy(project.id);
      if (!gone.current) {
        setData(d);
        setLoadError(null);
      }
      return d;
    } catch (err) {
      if (!gone.current) setLoadError(err);
      return null;
    }
  }, [project.id]);

  useEffect(() => {
    gone.current = false;
    setData(null);
    setAccepted(new Set());
    setStartError(null);
    load();
    return () => {
      gone.current = true;
    };
  }, [load]);

  // Follow a deploy while it runs.
  const latest = data?.deployments?.[0] ?? null;
  const running = Boolean(data?.running || isRunning(latest));
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);

  if (loadError) {
    const migrate = loadError.data?.needsMigration;
    return (
      <div className={ws.stepBody}>
        <Alert tone={migrate ? 'warn' : 'bad'} title={migrate ? T.migrateTitle : 'Go live could not be loaded'} action={<Button size="sm" onClick={load}>Try again</Button>}>
          {loadError.message}
        </Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={ws.stepBody}>
        <p className={ws.hint}><Spin size={14} aria-hidden="true" /> Loading…</p>
      </div>
    );
  }

  const { readiness, connection, deployments = [] } = data;
  if (readiness.blockers.some((b) => b.id === 'no-copy')) {
    return (
      <div className={ws.stepBody}>
        <EmptyState icon={Rocket} title="Make the copy first" action={<Button variant="primary" onClick={onGoCreate}>Create the copy</Button>}>
          Going live publishes your finished copy. Once a copy is made, it can be put online from here.
        </EmptyState>
      </div>
    );
  }

  const live = deployments.find((d) => d.status === 'ready') ?? null;
  const stackName = stackById(data.stack).name;
  const warnings = readiness.warnings ?? [];
  const allAccepted = warnings.every((w) => accepted.has(w.id));
  const canDeploy = Boolean(connection) && readiness.ok && allAccepted && !running && !starting;
  const latestFailed = latest?.status === 'failed' ? latest : null;

  async function deploy() {
    setStarting(true);
    setStartError(null);
    try {
      await api.startDeploy(project.id, { recreateId: data.recreateId, stack: data.stack, accept: [...accepted] });
      await load();
    } catch (err) {
      setStartError(err.message);
      await load();
    } finally {
      setStarting(false);
    }
  }

  async function disconnect() {
    await api.disconnectHosting('netlify').catch(() => {});
    setAskDisconnect(false);
    await load();
  }

  const toggle = (id) => setAccepted((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const steps = running ? STEP_ORDER.map((key, i) => {
    const at = STEP_ORDER.indexOf(latest?.step ?? 'package');
    return { key, ...T.steps[key], state: i < at ? 'done' : i === at ? 'active' : 'pending' };
  }) : null;

  return (
    <div className={ws.stepBody}>
      {live && (
        <Card
          icon={Globe}
          title={T.liveTitle}
          sub={T.liveFacts({ ...live, when: timeAgo(live.finishedAt) }, size(live.bytes))}
          actions={live.adminUrl && (
            <a className={styles.linkButton} href={live.adminUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden="true" /> {T.openNetlify}
            </a>
          )}
        >
          <p className={styles.liveLine}>
            <span className={styles.liveLabel}>{T.liveAt}</span>
            <a href={live.url} target="_blank" rel="noopener noreferrer" className={styles.liveUrl}>
              <Link2 size={15} aria-hidden="true" /> {live.url}
            </a>
          </p>
        </Card>
      )}

      <Card
        icon={KeyRound}
        title={T.accountTitle}
        sub={T.accountSub}
        actions={!connection && <Button variant="primary" onClick={() => setAsking(true)}>{T.connect}</Button>}
      >
        {connection ? (
          // Two buttons sit in the body, not the header: on a phone the header has no room for them beside the title.
          <div className={styles.accountRow}>
            <p className={ws.hint} style={{ margin: 0 }}>{T.connected(connection)}</p>
            <div className={styles.accountButtons}>
              <Button size="sm" onClick={() => setAsking(true)}>{T.replace}</Button>
              <Button size="sm" icon={Unplug} onClick={() => setAskDisconnect(true)}>{T.disconnect}</Button>
            </div>
          </div>
        ) : (
          <>
            <p className={ws.hint} style={{ marginTop: 0 }}>{T.notConnected}</p>
            <ol className={styles.howTo}>
              {T.howTo.map((line) => <li key={line}>{line}</li>)}
            </ol>
            <a className={styles.linkButton} href={T.tokenPage} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden="true" /> {T.openTokenPage}
            </a>
          </>
        )}
      </Card>

      <Card
        icon={CloudUpload}
        title={T.deployTitle}
        sub={(live ? T.updateSub : T.deploySub)(stackName, data.copiedAt ? timeAgo(data.copiedAt) : null)}
      >
        {readiness.blockers.length > 0 && (
          <Alert tone="bad" title={T.blockedTitle}>
            <ul className={styles.plainList}>
              {readiness.blockers.map((b) => <li key={b.id}>{b.text}</li>)}
            </ul>
          </Alert>
        )}
        {readiness.ok && warnings.length > 0 && !running && (
          <div className={styles.confirm}>
            <p className={styles.confirmTitle}>{T.confirmTitle}</p>
            <p className={ws.hint} style={{ margin: 0 }}>{T.confirmText}</p>
            <ul className={styles.warnings}>
              {warnings.map((w) => (
                <li key={w.id}>
                  <label className={form.check}>
                    <input type="checkbox" checked={accepted.has(w.id)} onChange={() => toggle(w.id)} />
                    <span>
                      {w.text}
                      <span className={styles.acceptNote}> {T.accept}.</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!connection && readiness.ok && <p className={ws.hint} style={{ margin: 0 }}>{T.needConnect}.</p>}
        {steps && <StepList steps={steps} />}
        {/* After the confirmations, where the eye ends up once they are ticked (and never squeezing the title on a phone). */}
        <div className={styles.deployRow}>
          <Button
            variant="primary"
            icon={running || starting ? Spin : Rocket}
            disabled={!canDeploy}
            onClick={deploy}
            title={!connection ? T.needConnect : undefined}
          >
            {live ? T.update : T.goLive}
          </Button>
        </div>
        {startError && (
          <Alert tone="bad" title="The deploy did not start">{startError}</Alert>
        )}
        {latestFailed && !running && (
          <Alert tone="bad" title={T.failedTitle}>
            {latestFailed.error} {live ? T.failedText : ''}
          </Alert>
        )}
      </Card>

      {live && (
        <Alert tone="info" title={T.domainTitle}>{T.domainText}</Alert>
      )}

      {deployments.length > 1 && (
        <SectionCard icon={History} title={T.historyTitle} meta={`${deployments.length} deploys`} defaultOpen={false}>
          <ul className={styles.history}>
            {deployments.map((d) => (
              <li key={d.id}>
                <span className={styles.badge} data-status={d.status}>{T.status[d.status] ?? d.status}</span>
                <span>{timeAgo(d.startedAt)}</span>
                <span className={ws.hint} style={{ margin: 0 }}>{stackById(d.stack).name}{d.files ? ` · ${d.files} files` : ''}</span>
                {d.status === 'failed' && d.error && <span className={styles.historyError}>{d.error}</span>}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <TokenDialog open={asking} onClose={() => setAsking(false)} onConnected={async () => { setAsking(false); await load(); }} />
      <ConfirmDialog open={askDisconnect} onClose={() => setAskDisconnect(false)} title={T.disconnectTitle} confirmLabel={T.disconnect} danger onConfirm={disconnect}>
        {T.disconnectText}
      </ConfirmDialog>
    </div>
  );
}

/** Asks for a Netlify personal access token; the server checks it with Netlify before keeping it. */
function TokenDialog({ open, onClose, onConnected }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const field = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    setToken('');
    setError(null);
    // The native dialog focuses its first control (the ×) when it opens, after this effect: the field is focused a frame later.
    const f = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(f);
  }, [open]);

  async function submit(e) {
    e.preventDefault();
    if (!token.trim()) return setError(T.tokenEmpty);
    setSaving(true);
    setError(null);
    try {
      await api.connectHosting('netlify', token.trim());
      setToken('');
      await onConnected();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={T.dialogTitle}
      description={T.dialogText}
      footer={
        <div style={{ display: 'flex', flexWrap: 'wrap-reverse', justifyContent: 'flex-end', gap: 'var(--sp-2)', width: '100%' }}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" type="submit" form="sas-token-form" icon={saving ? Spin : undefined} disabled={saving}>
            {saving ? T.checking : T.connect}
          </Button>
        </div>
      }
    >
      <form id="sas-token-form" className={form.form} onSubmit={submit} noValidate>
        <label className={form.field}>
          <span className={form.label}>{T.tokenLabel}</span>
          <input
            className={form.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-invalid={error ? 'true' : undefined}
            ref={field}
          />
        </label>
        {error && <p className={form.error} role="alert" style={{ margin: 0 }}>{error}</p>}
        <a className={styles.linkButton} href={T.tokenPage} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={14} aria-hidden="true" /> {T.openTokenPage}
        </a>
      </form>
    </Modal>
  );
}
