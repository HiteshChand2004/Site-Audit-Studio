import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, CircleCheck, CircleHelp, CircleX, CloudUpload, Power, Copy, Download, ExternalLink, Globe, History, Inbox, KeyRound, Link2, Loader2, RefreshCw, Rocket, Server, Trash2, Unplug, Upload } from 'lucide-react';
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
import { apiUrl } from '../../api/base.js';
import ws from '../Workspace.module.css';
import panel from '../Panel.module.css';
import styles from './GoLiveStep.module.css';

const STEP_ORDER = ['package', 'site', 'upload', 'publish'];
// Remastly's own server has no site to make and nothing to wait for: the files are written and live in one step.
const SERVER_STEPS = ['package', 'upload'];
const POLL_MS = 1500;
const isRunning = (d) => d && (d.status === 'queued' || d.status === 'running');
const Spin = (p) => <Loader2 {...p} className={panel.spin} />;

function size(bytes) {
  if (!Number.isFinite(bytes)) return 'size unknown';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Step 5: choose where the site goes live (Remastly hosting, set up once by the owner, or the person's own Netlify account), then
 * publish the latest copy and update it after every new one.
 */
export default function GoLiveStep({ project, onGoCreate }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [asking, setAsking] = useState(false);
  const [askDisconnect, setAskDisconnect] = useState(false);
  const [askRemastly, setAskRemastly] = useState(false);
  const [askRemoveRemastly, setAskRemoveRemastly] = useState(false);
  const [chosen, setChosen] = useState(null);
  const [domainInput, setDomainInput] = useState('');
  const [askRestore, setAskRestore] = useState(null);
  const [restoreError, setRestoreError] = useState(null);
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
    setChosen(null);
    // The original's own name, offered first: a copy usually takes its place.
    try { setDomainInput(new URL(project.url).hostname); } catch { setDomainInput(''); }
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
  const remastly = data.remastly ?? { ready: false, canManage: false, account: null };
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
  // Earlier versions of the same live site, newest first: each can be put back (Go back).
  const earlier = live ? deployments.filter((d) => d.status === 'ready' && d.id !== live.id && d.hosting === live.hosting && d.url === live.url && d.startedAt < live.startedAt) : [];
  const stackName = stackById(data.stack).name;
  const warnings = readiness.warnings ?? [];
  const allAccepted = warnings.every((w) => accepted.has(w.id));
  // Remastly hosting when it is set up, unless the person picks their own account.
  const server = data.server ?? { ready: false, ip: null, domain: null };
  // Remastly's own server when it is set up, then Remastly hosting on Netlify, then the person's own account; unless they chose.
  const target = chosen ?? (server.ready ? 'server' : remastly.ready ? 'remastly' : 'own');
  // The first deploy to the server needs the domain the site will answer at; later ones keep it.
  const askDomain = target === 'server' && server.ready && !server.domain;
  const placeReady = target === 'server' ? server.ready && (!askDomain || Boolean(domainInput.trim()))
    : target === 'remastly' ? remastly.ready : Boolean(connection);
  const needPlace = target === 'server' ? (server.ready ? T.needDomain : T.needServer) : target === 'remastly' ? T.needRemastly : T.needConnect;
  const canDeploy = placeReady && readiness.ok && allAccepted && !running && !starting;
  const latestFailed = latest?.status === 'failed' ? latest : null;

  async function deploy() {
    setStarting(true);
    setStartError(null);
    try {
      await api.startDeploy(project.id, { recreateId: data.recreateId, stack: data.stack, accept: [...accepted], target, ...(askDomain && { domain: domainInput.trim() }) });
      await load();
    } catch (err) {
      setStartError(err.message);
      await load();
    } finally {
      setStarting(false);
    }
  }

  async function restore() {
    const d = askRestore;
    setAskRestore(null);
    setRestoreError(null);
    try {
      await api.restoreDeploy(project.id, d.id);
    } catch (err) {
      setRestoreError(err.message);
    }
    await load();
  }

  async function removeRemastly() {
    await api.removeRemastlyHosting().catch(() => {});
    setAskRemoveRemastly(false);
    await load();
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

  const order = latest?.hosting === 'server' ? SERVER_STEPS : STEP_ORDER;
  const steps = running ? order.map((key, i) => {
    const at = order.indexOf(latest?.step ?? 'package');
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
          {earlier.length > 0 && !running && (
            <div className={styles.accountButtons} style={{ marginTop: 'var(--sp-3)' }}>
              <Button size="sm" icon={History} onClick={() => setAskRestore(earlier[0])}>{T.goBack}</Button>
            </div>
          )}
          {restoreError && <Alert tone="bad" title={T.putBackFailed}>{restoreError}</Alert>}
        </Card>
      )}

      <Card icon={Server} title={T.whereTitle} sub={T.whereSub}>
        <div className={styles.places} role="radiogroup" aria-label={T.whereTitle}>
          <label className={styles.place} data-active={target === 'server' || undefined}>
            <input type="radio" name="sas-place" checked={target === 'server'} onChange={() => setChosen('server')} disabled={running} />
            <span className={styles.placeText}>
              <span className={styles.placeName}>{T.serverOption} <span className={styles.recommended}>{T.recommended}</span></span>
              <span className={styles.placeExplain}>{T.serverOptionText}</span>
              {!server.ready && <span className={styles.placeExplain}>{T.serverNotReady}</span>}
            </span>
          </label>
          <label className={styles.place} data-active={target === 'remastly' || undefined}>
            <input type="radio" name="sas-place" checked={target === 'remastly'} onChange={() => setChosen('remastly')} disabled={running} />
            <span className={styles.placeText}>
              <span className={styles.placeName}>{T.remastlyOption}</span>
              <span className={styles.placeExplain}>{T.remastlyOptionText}</span>
              {!remastly.ready && !remastly.canManage && <span className={styles.placeExplain}>{T.remastlyNotReady}</span>}
            </span>
          </label>
          <label className={styles.place} data-active={target === 'own' || undefined}>
            <input type="radio" name="sas-place" checked={target === 'own'} onChange={() => setChosen('own')} disabled={running} />
            <span className={styles.placeText}>
              <span className={styles.placeName}>{T.ownOption}</span>
              <span className={styles.placeExplain}>{T.ownOptionText}</span>
            </span>
          </label>
        </div>
        {remastly.canManage && target === 'remastly' && (
          <div className={styles.accountRow} style={{ marginTop: 'var(--sp-3)' }}>
            <p className={ws.hint} style={{ margin: 0 }}>{remastly.account ? T.remastlyAccount(remastly.account) : T.remastlyNotReadyOwner}</p>
            <div className={styles.accountButtons}>
              {remastly.ready ? (
                <>
                  <Button size="sm" onClick={() => setAskRemastly(true)}>{T.remastlyReplace}</Button>
                  <Button size="sm" icon={Unplug} onClick={() => setAskRemoveRemastly(true)}>{T.remastlyRemove}</Button>
                </>
              ) : (
                <Button size="sm" variant="primary" onClick={() => setAskRemastly(true)}>{T.remastlySetUp}</Button>
              )}
            </div>
          </div>
        )}
      </Card>

      {target === 'own' && (
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
      )}

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
        {askDomain && readiness.ok && !running && (
          <label className={form.field}>
            <span className={form.label}>{T.serverDomainLabel}</span>
            <input className={form.input} value={domainInput} onChange={(e) => setDomainInput(e.target.value)} placeholder={T.domainPlaceholder} autoComplete="off" spellCheck={false} inputMode="url" />
            <span className={ws.hint} style={{ margin: 0 }}>{T.serverDomainHelp}</span>
          </label>
        )}
        {!placeReady && readiness.ok && <p className={ws.hint} style={{ margin: 0 }}>{needPlace}.</p>}
        {steps && <StepList steps={steps} />}
        {/* After the confirmations, where the eye ends up once they are ticked (and never squeezing the title on a phone). */}
        <div className={styles.deployRow}>
          <Button
            variant="primary"
            icon={running || starting ? Spin : Rocket}
            disabled={!canDeploy}
            onClick={deploy}
            title={!placeReady ? needPlace : undefined}
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

      {live && <DomainCard project={project} liveUrl={live.url} />}

      <FormsCard project={project} onChange={load} />

      <SnapshotCard project={project} onChange={load} />

      <PassThroughCard project={project} onChange={load} />

      <SwitchOffCard project={project} />

      {deployments.length > 1 && (
        <SectionCard icon={History} title={T.historyTitle} meta={`${deployments.length} deploys`} defaultOpen={false}>
          <ul className={styles.history}>
            {deployments.map((d) => (
              <li key={d.id}>
                <span className={styles.badge} data-status={d.status}>{d.restoredFrom ? T.restored : T.status[d.status] ?? d.status}</span>
                <span>{timeAgo(d.startedAt)}</span>
                <span className={ws.hint} style={{ margin: 0 }}>{stackById(d.stack).name}{d.files ? ` · ${d.files} files` : ''}</span>
                {d.id === live?.id && <span className={ws.hint} style={{ margin: 0 }}>· {T.liveNow}</span>}
                {earlier.some((e) => e.id === d.id) && !running && (
                  <Button size="sm" onClick={() => setAskRestore(d)}>{T.putBack}</Button>
                )}
                {d.status === 'failed' && d.error && <span className={styles.historyError}>{d.error}</span>}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <ConfirmDialog open={Boolean(askRestore)} onClose={() => setAskRestore(null)} title={T.putBackTitle} confirmLabel={T.putBack} onConfirm={restore}>
        {askRestore ? T.putBackText(timeAgo(askRestore.startedAt)) : ''}
      </ConfirmDialog>
      <TokenDialog open={asking} onClose={() => setAsking(false)} onConnected={async () => { setAsking(false); await load(); }} />
      <TokenDialog remastly open={askRemastly} onClose={() => setAskRemastly(false)} onConnected={async () => { setAskRemastly(false); setChosen(null); await load(); }} />
      <ConfirmDialog open={askRemoveRemastly} onClose={() => setAskRemoveRemastly(false)} title={T.remastlyRemoveTitle} confirmLabel={T.remastlyRemove} danger onConfirm={removeRemastly}>
        {T.remastlyRemoveText}
      </ConfirmDialog>
      <ConfirmDialog open={askDisconnect} onClose={() => setAskDisconnect(false)} title={T.disconnectTitle} confirmLabel={T.disconnect} danger onConfirm={disconnect}>
        {T.disconnectText}
      </ConfirmDialog>
    </div>
  );
}

/**
 * Asks for a Netlify personal access token; the server checks it with Netlify before keeping it. `remastly`: the token of
 * Remastly's own hosting account (owner only), instead of the person's own.
 */
function TokenDialog({ open, onClose, onConnected, remastly = false }) {
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
      if (remastly) await api.setupRemastlyHosting(token.trim());
      else await api.connectHosting('netlify', token.trim());
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
      title={remastly ? T.remastlyDialogTitle : T.dialogTitle}
      description={remastly ? T.remastlyDialogText : T.dialogText}
      footer={
        <div style={{ display: 'flex', flexWrap: 'wrap-reverse', justifyContent: 'flex-end', gap: 'var(--sp-2)', width: '100%' }}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" type="submit" form={remastly ? 'sas-remastly-token-form' : 'sas-token-form'} icon={saving ? Spin : undefined} disabled={saving}>
            {saving ? T.checking : remastly ? T.remastlySetUp : T.connect}
          </Button>
        </div>
      }
    >
      <form id={remastly ? 'sas-remastly-token-form' : 'sas-token-form'} className={form.form} onSubmit={submit} noValidate>
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

/** Step 2: the owner's own domain on the live site — the DNS records to add, and which are in place. */
function DomainCard({ project, liveUrl }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [askRemove, setAskRemove] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const d = await api.getDomain(project.id);
      setState(d);
      setError(null);
      if (!d.domain) setDomain((cur) => cur || d.suggestion || '');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [project.id]);

  // Again when a new deploy changed the live site.
  useEffect(() => { load(); }, [load, liveUrl]);

  async function connect(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setState(await api.setDomain(project.id, domain.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setAskRemove(false);
    setBusy(true);
    try {
      setState(await api.removeDomain(project.id));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const records = state?.records ?? [];
  return (
    <Card icon={Globe} title={T.domainCardTitle} sub={T.domainCardSub}>
      {!state && !error && <p className={ws.hint} style={{ margin: 0 }}><Spin size={14} aria-hidden="true" /> Loading…</p>}
      {state && !state.domain && (
        <form className={styles.domainForm} onSubmit={connect} noValidate>
          <label className={form.field} style={{ flex: 1, minWidth: 0 }}>
            <span className={form.label}>{T.domainLabel}</span>
            <input
              className={form.input}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={T.domainPlaceholder}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </label>
          <Button variant="primary" type="submit" icon={busy ? Spin : undefined} disabled={busy || !domain.trim()}>
            {busy ? T.domainConnecting : T.domainConnect}
          </Button>
        </form>
      )}
      {state?.domain && (
        <div className={styles.domainBody}>
          {state.connected ? (
            <Alert tone="ok" title={T.domainConnected(state.domain)}>{state.https ? T.domainHttpsOn : T.domainHttpsPending}</Alert>
          ) : (
            <>
              <p className={ws.hint} style={{ margin: 0 }}>{T.domainWaiting}</p>
              <p className={styles.moveNote}>{T.domainMoves(state.domain)}</p>
            </>
          )}
          <div className={styles.tableWrap}>
            <table className={styles.records}>
              <thead>
                <tr>
                  <th>{T.domainCols.type}</th>
                  <th>{T.domainCols.name}</th>
                  <th>{T.domainCols.value}</th>
                  <th>{T.domainCols.status}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={`${r.type}-${r.host}`}>
                    <td>{r.type}</td>
                    <td><code>{r.name}</code></td>
                    <td><span className={styles.value}><code>{r.value}</code> <CopyButton text={r.value} /></span></td>
                    <td>
                      <span className={styles.badge} data-status={r.ok ? 'ready' : r.required ? 'failed' : undefined}>
                        {r.ok ? T.domainOk : r.required ? T.domainMissing : T.domainOptional}
                      </span>
                      {!r.ok && r.found?.length > 0 && <span className={styles.found}>{T.domainNow(r.found)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={ws.hint} style={{ margin: 0 }}>{T.domainSameName} {records.some((r) => !r.required) ? T.domainOptionalNote : ''}</p>
          <div className={styles.accountButtons}>
            <Button size="sm" icon={busy ? Spin : RefreshCw} disabled={busy} onClick={load}>{T.domainCheck}</Button>
            <Button size="sm" icon={Unplug} disabled={busy} onClick={() => setAskRemove(true)}>{T.domainRemove}</Button>
          </div>
        </div>
      )}
      {error && <Alert tone="bad" title="The domain could not be changed">{error}</Alert>}
      <ConfirmDialog open={askRemove} onClose={() => setAskRemove(false)} title={T.domainRemoveTitle} confirmLabel={T.domainRemove} danger onConfirm={remove}>
        {T.domainRemoveText}
      </ConfirmDialog>
    </Card>
  );
}

/** Copies a record's value, so it is pasted at the DNS company exactly. */
function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      // No clipboard (an insecure page): the value is on screen to copy by hand.
    }
  }
  return (
    <button type="button" className={styles.copy} onClick={copy} aria-label={`${T.copyValue} ${text}`}>
      {done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {done ? T.copied : T.copyValue}
    </button>
  );
}

/** Step 3: the old app's address and the paths passed to it on the live site (logins, dashboards, /api/…). */
function PassThroughCard({ project, onChange }) {
  const [state, setState] = useState(null);
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState('');
  const [paths, setPaths] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [insecure, setInsecure] = useState(false);
  const [askRemove, setAskRemove] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getPassThrough(project.id);
      setState(d);
      setTarget(d.passThrough?.target ?? '');
      setPaths((d.passThrough?.paths ?? d.suggestions.map((s) => s.path)).join('\n'));
      setEditing(false);
    } catch (err) {
      setError(err.message);
    }
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await api.setPassThrough(project.id, { target: target.trim(), paths: paths.split('\n') });
      setInsecure(Boolean(d.insecure));
      await load();
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setAskRemove(false);
    await api.removePassThrough(project.id).catch((err) => setError(err.message));
    await load();
    await onChange();
  }

  if (!state) return null;
  const saved = state.passThrough;
  const showForm = editing || (!saved && state.suggestions.length > 0);
  return (
    <Card icon={Link2} title={T.ptTitle} sub={T.ptSub}>
      {saved && !editing && (
        <div className={styles.domainBody}>
          <p className={ws.hint} style={{ margin: 0 }}>{T.ptSaved}</p>
          <pre className={styles.rules}>{state.rules}</pre>
          {insecure && <Alert tone="warn" title="Not encrypted">{T.ptInsecure}</Alert>}
          <p className={ws.hint} style={{ margin: 0 }}>{T.ptApply}</p>
          <div className={styles.accountButtons}>
            <Button size="sm" onClick={() => setEditing(true)}>{T.ptEdit}</Button>
            <Button size="sm" icon={Unplug} onClick={() => setAskRemove(true)}>{T.ptRemove}</Button>
          </div>
        </div>
      )}
      {!saved && !showForm && (
        <div className={styles.accountRow}>
          <p className={ws.hint} style={{ margin: 0 }}>{T.ptNone}</p>
          <Button size="sm" onClick={() => setEditing(true)}>{T.ptSet}</Button>
        </div>
      )}
      {showForm && (
        <form className={form.form} onSubmit={save} noValidate>
          <p className={ws.hint} style={{ margin: 0 }}>{T.ptExplain}</p>
          {state.suggestions.length > 0 && (
            <p className={ws.hint} style={{ margin: 0 }}>
              {T.ptSuggested} {state.suggestions.map((s) => <code key={s.path} className={styles.chip}>{s.seen}</code>)}
            </p>
          )}
          <label className={form.field}>
            <span className={form.label}>{T.ptTarget}</span>
            <input className={form.input} value={target} onChange={(e) => setTarget(e.target.value)} placeholder={T.ptTargetPlaceholder} autoComplete="off" spellCheck={false} inputMode="url" />
          </label>
          <label className={form.field}>
            <span className={form.label}>{T.ptPaths}</span>
            <textarea className={form.input} rows={4} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={T.ptPathsPlaceholder} spellCheck={false} />
          </label>
          <div className={styles.accountButtons}>
            <Button variant="primary" type="submit" icon={busy ? Spin : undefined} disabled={busy || !target.trim() || !paths.trim()}>{busy ? T.ptSaving : T.ptSave}</Button>
            {editing && <Button onClick={() => load()} disabled={busy}>Cancel</Button>}
          </div>
        </form>
      )}
      {error && <Alert tone="bad" title="Not saved">{error}</Alert>}
      <ConfirmDialog open={askRemove} onClose={() => setAskRemove(false)} title={T.ptRemoveTitle} confirmLabel={T.ptRemove} danger onConfirm={remove}>
        {T.ptRemoveText}
      </ConfirmDialog>
    </Card>
  );
}

/** Form entries: the site's forms save to Remastly (from the next deploy), with the latest entries and a CSV of all. */
function FormsCard({ project, onChange }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [askRemove, setAskRemove] = useState(null);
  const [imported, setImported] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      setState(await api.getForms(project.id));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  async function change(body) {
    setBusy(true);
    try {
      setState(await api.setForms(project.id, body));
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    setImported(null);
    try {
      const d = await api.importFormEntries(project.id, file);
      setState(d);
      setImported(d.imported);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function undoImport() {
    setBusy(true);
    try {
      setState(await api.removeFormImport(project.id, imported.importId));
      setImported(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const e = askRemove;
    setAskRemove(null);
    try {
      setState(await api.removeFormEntry(project.id, e.id));
    } catch (err) {
      setError(err.message);
    }
  }

  if (!state) return error ? <Alert tone="bad" title="Form entries could not be loaded">{error}</Alert> : null;
  if (!state.forms && !state.count && !state.enabled) {
    return (
      <Card icon={Inbox} title={T.formsTitle} sub={T.formsSub}>
        <p className={ws.hint} style={{ margin: 0 }}>{T.formsNone}</p>
      </Card>
    );
  }
  return (
    <Card icon={Inbox} title={T.formsTitle} sub={T.formsSub}>
      <div className={styles.domainBody}>
        {state.forms > 0 && <p className={ws.hint} style={{ margin: 0 }}>{T.formsWaiting(state.forms)}</p>}
        <label className={form.check}>
          <input type="checkbox" checked={state.enabled} disabled={busy} onChange={(e) => change({ enabled: e.target.checked })} />
          <span>{T.formsSave}</span>
        </label>
        {state.enabled && (
          <label className={form.check}>
            <input type="checkbox" checked={state.email} disabled={busy} onChange={(e) => change({ email: e.target.checked })} />
            <span>{T.formsEmail}</span>
          </label>
        )}
        {state.enabled && !state.reachable && <Alert tone="warn" title="Not reachable from live sites">{T.formsUnreachable}</Alert>}
        {state.enabled && state.reachable && <p className={ws.hint} style={{ margin: 0 }}>{T.formsApply}</p>}

        <div className={styles.accountRow}>
          <p className={styles.confirmTitle}>{T.formsCount(state.count)}</p>
          <div className={styles.accountButtons}>
            <Button size="sm" icon={busy ? Spin : Upload} disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? T.formsImporting : T.formsImport}
            </Button>
            {state.count > 0 && (
              <a className={styles.linkButton} href={apiUrl(`/projects/${project.id}/forms/entries.csv`)} download>
                <Download size={14} aria-hidden="true" /> {T.formsCsv}
              </a>
            )}
          </div>
          <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={importFile} />
        </div>
        {state.count === 0 && <p className={ws.hint} style={{ margin: 0 }}>{T.formsImportHelp}</p>}
        {imported && (
          <Alert tone="ok" title={T.formsImported(imported)} action={imported.added > 0 ? <Button size="sm" onClick={undoImport} disabled={busy}>{T.formsUndoImport}</Button> : undefined} />
        )}
        {state.count === 0 ? (
          <p className={ws.hint} style={{ margin: 0 }}>{T.formsEmpty}</p>
        ) : (
          <ul className={styles.entries}>
            {state.entries.map((e) => (
              <li key={e.id} className={styles.entry}>
                <div className={styles.entryHead}>
                  <span className={ws.hint} style={{ margin: 0 }}>
                    {timeAgo(e.at)}{e.page ? ` · ${e.page}` : ''}
                    {e.importId && <span className={styles.badge} style={{ marginLeft: 8 }}>{T.formsImportedTag}</span>}
                  </span>
                  <button type="button" className={styles.copy} onClick={() => setAskRemove(e)} aria-label={T.formsRemove}>
                    <Trash2 size={13} aria-hidden="true" /> {T.formsRemove}
                  </button>
                </div>
                <dl className={styles.fields}>
                  {e.fields.map(([k, v], i) => (
                    <div key={`${k}-${i}`}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                  {e.files?.length > 0 && (
                    <div>
                      <dt>{T.formsFiles}</dt>
                      <dd>{e.files.map((f) => f.name).join(', ')}</dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )}
        {state.count > state.entries.length && <p className={ws.hint} style={{ margin: 0 }}>{T.formsShown(state.entries.length, state.count)}</p>}
        {error && <Alert tone="bad" title="Not saved">{error}</Alert>}
      </div>
      <ConfirmDialog open={Boolean(askRemove)} onClose={() => setAskRemove(null)} title={T.formsRemoveTitle} confirmLabel={T.formsRemove} danger onConfirm={remove}>
        {T.formsRemoveText}
      </ConfirmDialog>
    </Card>
  );
}

const OFF_ICON = { ok: CircleCheck, needs: CircleX, advice: CircleHelp };

/** "Can I switch off the old server?": run on demand (it asks the host and DNS), item by item with a verdict. */
function SwitchOffCard({ project }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // A result is about one website: another website's page starts empty.
  useEffect(() => { setResult(null); setError(null); }, [project.id]);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.getSwitchOff(project.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const needs = result ? result.items.filter((i) => i.status === 'needs').length : 0;
  return (
    <Card icon={Power} title={T.offTitle} sub={T.offSub} actions={<Button size="sm" icon={busy ? Spin : RefreshCw} disabled={busy} onClick={check}>{busy ? T.offChecking : T.offCheck}</Button>}>
      {result && (
        <div className={styles.domainBody}>
          {result.safe
            ? <Alert tone="ok" title={T.offSafe}>{T.offSafeText}</Alert>
            : <Alert tone="bad" title={T.offNotYet(needs)} />}
          <ul className={styles.offItems}>
            {result.items.map((i) => {
              const Icon = OFF_ICON[i.status];
              return (
                <li key={i.id} data-status={i.status}>
                  <Icon size={16} aria-hidden="true" />
                  <span><strong>{T.offStatus[i.status]}:</strong> {i.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {error && <Alert tone="bad" title="Could not check">{error}</Alert>}
    </Card>
  );
}

// Long lists (a site may ask for dozens of addresses) show their first few.
const SHOWN = 6;

/** Content snapshot: the old site's answers to the copy's data calls, saved into the copy (from the next deploy). */
function SnapshotCard({ project, onChange }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setState(null);
    api.getSnapshot(project.id).then(setState, (err) => setError(err.message));
  }, [project.id]);

  async function run(call) {
    setBusy(true);
    setError(null);
    try {
      setState(await call(project.id));
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Nothing to show for a copy that asks the old site for no data and has no snapshot.
  if (!state || (!state.calls.length && !state.snapshot)) return null;
  const snap = state.snapshot;
  return (
    <Card icon={Camera} title={T.snapTitle} sub={T.snapSub}>
      <div className={styles.domainBody}>
        <div className={styles.note}>
          {T.snapCalls}
          <div className={styles.chips}>
            {state.calls.slice(0, SHOWN).map((c) => <code key={c} className={styles.chip}>{c}</code>)}
            {state.calls.length > SHOWN && <span>{T.andMore(state.calls.length - SHOWN)}</span>}
          </div>
        </div>
        {snap && (
          <>
            {snap.items.length > 0 && <Alert tone="ok" title={T.snapTaken(snap.items.length, timeAgo(snap.takenAt))}>{T.snapMoment}</Alert>}
            {snap.failed.length > 0 && (
              <div className={styles.note}>
                {T.snapFailed}
                <ul className={styles.plainList}>
                  {snap.failed.slice(0, SHOWN).map((f) => <li key={f.address}><code className={styles.chip}>{f.address}</code> {f.why}</li>)}
                  {snap.failed.length > SHOWN && <li>{T.andMore(snap.failed.length - SHOWN)}</li>}
                </ul>
              </div>
            )}
            {state.shadowed.length > 0 && <p className={ws.hint} style={{ margin: 0 }}>{T.snapShadowed(state.shadowed)}</p>}
          </>
        )}
        <p className={ws.hint} style={{ margin: 0 }}>{T.snapLogin}</p>
        <div className={styles.accountButtons}>
          {state.calls.length > 0 && (
            <Button size="sm" variant={snap ? undefined : 'primary'} icon={busy ? Spin : Camera} disabled={busy} onClick={() => run(api.takeSnapshot)}>
              {busy ? T.snapTaking : snap ? T.snapRetake : T.snapTake}
            </Button>
          )}
          {snap && <Button size="sm" icon={Trash2} disabled={busy} onClick={() => run(api.removeSnapshot)}>{T.snapRemove}</Button>}
        </div>
        {error && <Alert tone="bad" title="Not saved">{error}</Alert>}
      </div>
    </Card>
  );
}
