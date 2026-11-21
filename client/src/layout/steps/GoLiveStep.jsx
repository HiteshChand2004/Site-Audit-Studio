import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Camera, Check, CircleCheck, CircleHelp, CircleX, CloudUpload, Code, Power, Copy, Download, ExternalLink, Globe, History, Inbox, Link2, Loader2, RefreshCw, Rocket, Server, Trash2, Unplug, Upload } from 'lucide-react';
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
import OldServerImport from './OldServerImport.jsx';
import AppGithubMaker from './AppGithubMaker.jsx';
import AppSettings from './AppSettings.jsx';

// Remastly's own server: the files are packed, then written and live in one step.
const STEPS = ['package', 'upload'];
const POLL_MS = 1500;
const isRunning = (d) => d && (d.status === 'queued' || d.status === 'running');
const Spin = (p) => <Loader2 {...p} className={panel.spin} />;

function size(bytes) {
  if (!Number.isFinite(bytes)) return 'size unknown';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Step 5: publish the latest copy on Remastly's own server at its domain, and update it after every new one. (Sites put on Netlify
 * before keep their link, history and Go back here; new ones go to Remastly's server only.)
 */
export default function GoLiveStep({ project, onGoCreate }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [domainInput, setDomainInput] = useState('');
  const [askSetup, setAskSetup] = useState(false);
  // What the domain card last read: whether the site's domain points to Remastly's server (so visitors see this copy).
  const [domainState, setDomainState] = useState(null);
  // The box changes where Logins and data go: that card reads it again.
  const [boxTick, setBoxTick] = useState(0);
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
    setDomainState(null);
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

  const { readiness, deployments = [] } = data;
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
  const server = data.server ?? { ready: false, ip: null, domain: null, canSetUp: false };
  // The first deploy needs the domain the site will answer at; later ones keep it.
  const askDomain = server.ready && !server.domain;
  const placeReady = server.ready && (!askDomain || Boolean(domainInput.trim()));
  const needPlace = server.ready ? T.needDomain : T.needServer;
  const canDeploy = placeReady && readiness.ok && allAccepted && !running && !starting;
  const latestFailed = latest?.status === 'failed' ? latest : null;

  async function deploy() {
    setStarting(true);
    setStartError(null);
    try {
      await api.startDeploy(project.id, { recreateId: data.recreateId, stack: data.stack, accept: [...accepted], target: 'server', ...(askDomain && { domain: domainInput.trim() }) });
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

  const toggle = (id) => setAccepted((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  // A site on Remastly's server is live only once its domain points there; until then it is ready, and the link would open
  // whatever the domain still leads to (the original). A site live on Netlify is at its own address.
  const onServer = live?.hosting === 'server';
  const visible = !onServer || domainState?.connected === true;
  const required = (domainState?.records ?? []).find((r) => r.required);
  const notVisibleText = !domainState ? T.checkingText
    : !domainState.domain ? T.noDomainText
      : T.readyText(domainState.domain, required?.found ?? []);

  const steps = running ? STEPS.map((key, i) => {
    const at = STEPS.indexOf(latest?.step ?? 'package');
    return { key, ...T.steps[key], state: i < at ? 'done' : i === at ? 'active' : 'pending' };
  }) : null;

  return (
    <div className={ws.stepBody}>
      {live && (
        <Card
          icon={Globe}
          title={visible ? T.liveTitle : domainState ? T.readyTitle : T.checkingTitle}
          sub={T.liveFacts({ ...live, when: timeAgo(live.finishedAt) }, size(live.bytes))}
          actions={live.adminUrl && (
            <a className={styles.linkButton} href={live.adminUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden="true" /> {T.openNetlify}
            </a>
          )}
        >
          {visible ? (
            <p className={styles.liveLine}>
              <span className={styles.liveLabel}>{T.liveAt}</span>
              <a href={live.url} target="_blank" rel="noopener noreferrer" className={styles.liveUrl}>
                <Link2 size={15} aria-hidden="true" /> {live.url}
              </a>
            </p>
          ) : (
            <p className={ws.hint} style={{ margin: 0 }}>{notVisibleText}</p>
          )}
          {earlier.length > 0 && !running && (
            <div className={styles.accountButtons} style={{ marginTop: 'var(--sp-3)' }}>
              <Button size="sm" icon={History} onClick={() => setAskRestore(earlier[0])}>{T.goBack}</Button>
            </div>
          )}
          {restoreError && <Alert tone="bad" title={T.putBackFailed}>{restoreError}</Alert>}
        </Card>
      )}

      <Card icon={Server} title={T.whereTitle} sub={T.whereSub}>
        {server.ready
          ? <p className={ws.hint} style={{ margin: 0 }}>{T.serverReady(server.ip)}</p>
          : <p className={ws.hint} style={{ margin: 0 }}>{T.serverNotReady}</p>}
        {/* The setup is done once; its steps are only offered while it is not. */}
        {server.canSetUp && !server.ready && (
          <div className={styles.accountButtons} style={{ marginTop: 'var(--sp-3)' }}>
            <Button size="sm" onClick={() => setAskSetup(true)}>{T.serverSetupButton}</Button>
          </div>
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

      {live && <DomainCard project={project} liveUrl={live.url} onState={setDomainState} />}

      <FormsCard project={project} onChange={load} />

      <SnapshotCard project={project} onChange={load} />

      <PassThroughCard key={boxTick} project={project} onChange={load} />

      <BoxCard project={project} onChange={async () => { setBoxTick((t) => t + 1); await load(); }} />
      <AppCard project={project} onChange={async () => { setBoxTick((t) => t + 1); await load(); }} />

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
      <ServerSetupDialog open={askSetup} onClose={() => setAskSetup(false)} />
    </div>
  );
}

/**
 * Step 2 done by Remastly: when the domain is at GoDaddy, the person connects their GoDaddy account once (an API key and
 * secret, kept sealed on the server) and Remastly changes the records itself; what they pointed to before can be put back.
 */
function GoDaddyBox({ project, domain, pointsHere, onDomain }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  // GoDaddy's older credential, until it retires it for domains (end of 2026).
  const [withKey, setWithKey] = useState(false);
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [ask, setAsk] = useState(null);

  const load = useCallback(async () => {
    try {
      setCard(await api.getGoDaddy(project.id));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [project.id]);
  // Again when the domain changes: what GoDaddy would change depends on it.
  useEffect(() => { load(); }, [load, domain]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const connect = (e) => {
    e.preventDefault();
    run(async () => {
      await api.connectGoDaddy(withKey ? { key: key.trim(), secret: secret.trim() } : { token: token.trim() });
      setToken('');
      setKey('');
      setSecret('');
      await load();
    });
  };
  // The answer holds the domain's state too, so the records table above follows at once.
  const change = (call) => run(async () => {
    const r = await call(project.id);
    setCard(r.godaddy);
    if (r.domain) onDomain(r.domain);
  });

  if (!card) return error ? <Alert tone="bad" title="GoDaddy">{error}</Alert> : null;
  const plan = card.plan;
  // Always offered, never required: the records can as well be added by hand (the table above).
  return (
    <div className={styles.godaddy}>
      <p className={styles.godaddyTitle}>{T.gdTitle} <span className={styles.badge}>{T.gdOptional}</span></p>
      {pointsHere && !card.changed && <p className={ws.hint} style={{ margin: 0 }}>{T.gdInPlace}</p>}
      {card.changed && <Alert tone="ok" title={T.gdDone(timeAgo(card.changed.at))}>{card.changed.names.join(', ')}</Alert>}
      {!card.connected && (
        <>
          {card.changed ? <p className={ws.hint} style={{ margin: 0 }}>{T.gdReconnect}</p> : <p className={ws.hint} style={{ margin: 0 }}>{T.gdIntro}</p>}
          {!withKey && <ol className={styles.howList}>{T.gdSteps.map((t) => <li key={t}>{t}</li>)}</ol>}
          <a href={withKey ? 'https://developer.godaddy.com/keys' : 'https://developer.godaddy.com/docs/api-users/auth/how-to'} target="_blank" rel="noreferrer noopener">{T.gdKeyPage} <ExternalLink size={12} aria-hidden="true" /></a>
          <form className={styles.domainBody} onSubmit={connect} noValidate>
            {withKey ? (
              <>
                <div className={styles.godaddyFields}>
                  <label className={form.field}>
                    <span className={form.label}>{T.gdKey}</span>
                    <input className={form.input} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
                  </label>
                  <label className={form.field}>
                    <span className={form.label}>{T.gdSecret}</span>
                    <input className={form.input} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
                  </label>
                </div>
                <p className={ws.hint} style={{ margin: 0 }}>{T.gdKeyNote}</p>
              </>
            ) : (
              <label className={form.field}>
                <span className={form.label}>{T.gdToken}</span>
                <input className={form.input} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            )}
            <div className={styles.accountButtons}>
              <Button variant="primary" type="submit" icon={busy ? Spin : undefined} disabled={busy || (withKey ? !key.trim() || !secret.trim() : !token.trim())}>
                {busy ? T.gdConnecting : T.gdConnect}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setWithKey((v) => !v)}>{withKey ? T.gdUseToken : T.gdUseKey}</Button>
            </div>
          </form>
        </>
      )}
      {card.connected && (
        <>
          {card.problem && <Alert tone="warn" title={card.problem} />}
          {plan?.needed && (
            <div className={styles.tableWrap}>
              <table className={styles.records}>
                <thead>
                  <tr><th>{T.gdCols.name}</th><th>{T.gdCols.now}</th><th>{T.gdCols.next}</th></tr>
                </thead>
                <tbody>
                  {plan.changes.filter((c) => c.needed).map((c) => (
                    <tr key={c.host}>
                      <td><code>{c.host}</code></td>
                      <td>{c.now.length ? c.now.map((n) => <code key={n} style={{ display: 'block' }}>{n}</code>) : T.gdNothing}</td>
                      <td><code>{c.type} {c.value}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={ws.hint} style={{ margin: 0 }}>{card.source === 'server' ? T.gdFromServer(card.accounts) : T.gdConnected(card.account)}</p>
          <div className={styles.accountButtons}>
            {plan?.needed && (
              <Button variant="primary" size="sm" icon={busy ? Spin : Globe} disabled={busy} onClick={() => setAsk('apply')}>{busy ? T.gdApplying : T.gdApply}</Button>
            )}
            {card.changed && <Button size="sm" icon={History} disabled={busy} onClick={() => setAsk('undo')}>{T.gdUndo}</Button>}
            {/* The server's own tokens are changed in its settings, not here. */}
            {card.source !== 'server' && (
              <Button size="sm" icon={Unplug} disabled={busy} onClick={() => run(async () => { await api.disconnectGoDaddy(); await load(); })}>{T.gdDisconnect}</Button>
            )}
          </div>
        </>
      )}
      {error && <Alert tone="bad" title="GoDaddy">{error}</Alert>}
      <ConfirmDialog open={ask === 'apply'} onClose={() => setAsk(null)} title={T.gdApplyTitle} confirmLabel={T.gdApply} onConfirm={() => { setAsk(null); change(api.applyGoDaddy); }}>
        {T.gdApplyText(domain)}
      </ConfirmDialog>
      <ConfirmDialog open={ask === 'undo'} onClose={() => setAsk(null)} title={T.gdUndoTitle} confirmLabel={T.gdUndo} danger onConfirm={() => { setAsk(null); change(api.undoGoDaddy); }}>
        {T.gdUndoText}
      </ConfirmDialog>
    </div>
  );
}

/**
 * "Remove domain": the site stops answering at the domain on Remastly; when the server the domain was on before still answers
 * the site, the domain can be pointed back there (by Remastly at GoDaddy, else by hand), and Remastly keeps answering while the
 * change spreads.
 */
function RemoveDomainDialog({ open, project, onClose, onDone }) {
  const [back, setBack] = useState(null);
  const [ip, setIp] = useState('');
  const [pointBack, setPointBack] = useState(true);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const look = useCallback(async (typed) => {
    setChecking(true);
    setError(null);
    try {
      const b = await api.domainBack(project.id, typed);
      setBack(b);
      if (b.ip) setIp(b.ip);
      // Pointing back is offered ticked only when the old server answers the site.
      setPointBack(Boolean(b.check?.works));
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }, [project.id]);
  useEffect(() => {
    if (!open) return;
    setBack(null);
    setIp('');
    look();
  }, [open, look]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const useBack = pointBack && back?.check?.works;
      onDone(await api.removeDomain(project.id, useBack ? { pointBack: true, ip: back.ip } : undefined));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const works = back?.check?.works;
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={T.domainRemoveTitle} width={520}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="dangerSolid" onClick={remove} disabled={busy || checking || !back || (pointBack && works && !back.auto && !back.pointed)}>
            {busy ? 'Please wait…' : pointBack && works ? T.backRemoveAndPoint : T.domainRemove}
          </Button>
        </>
      )}>
      <div className={styles.domainBody}>
        {!back && !error && <p className={ws.hint} style={{ margin: 0 }}><Spin size={14} aria-hidden="true" /> {T.backLooking}</p>}
        {back && (!back.supported || !back.domain) && <p className={ws.hint} style={{ margin: 0 }}>{T.domainRemoveText}</p>}
        {back?.supported && back.domain && (
          <>
            <p className={ws.hint} style={{ margin: 0 }}>{back.ip ? T.backBefore(back.domain, back.ip, back.source) : T.backUnknown(back.domain)}</p>
            <form className={styles.domainForm} onSubmit={(e) => { e.preventDefault(); look(ip.trim()); }} noValidate>
              <label className={form.field} style={{ flex: 1, minWidth: 0 }}>
                <span className={form.label}>{T.backIpLabel}</span>
                <input className={form.input} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="13.232.143.64" inputMode="decimal" autoComplete="off" spellCheck={false} />
              </label>
              <Button size="sm" type="submit" icon={checking ? Spin : RefreshCw} disabled={checking || !ip.trim()}>{T.backCheck}</Button>
            </form>
            {back.check && (works
              ? <Alert tone="ok" title={T.backWorks(back.ip, back.domain)} />
              : <Alert tone="bad" title={T.backBroken(back.ip, back.domain)}>{back.check.reason}</Alert>)}
            {works && (
              <label className={form.check}>
                <input type="checkbox" checked={pointBack} onChange={(e) => setPointBack(e.target.checked)} />
                <span>{T.backPoint(back.domain, back.ip)} {back.auto ? T.backAuto : back.pointed ? T.backPointed : T.backManual}</span>
              </label>
            )}
            {/* Changed by hand: the records to change, and a check that the domain's DNS shows them. */}
            {works && pointBack && !back.auto && !back.pointed && (
              <>
                <ul className={styles.howList}>
                  {back.records.map((r) => <li key={r.name}><code>{r.type} {r.name} → {r.value}</code></li>)}
                </ul>
                <div className={styles.accountButtons}>
                  <Button size="sm" icon={checking ? Spin : RefreshCw} disabled={checking} onClick={() => look(back.ip)}>{T.backCheckDns}</Button>
                </div>
              </>
            )}
            {!(pointBack && works) && <Alert tone="warn" title={T.backStaysTitle}>{T.domainRemoveText}</Alert>}
          </>
        )}
        {error && <Alert tone="bad" title="Not done">{error}</Alert>}
      </div>
    </Modal>
  );
}

/** Step 2: the owner's own domain on the live site — the DNS records to add, and which are in place. */
function DomainCard({ project, liveUrl, onState }) {
  const [state, setState] = useState(null);
  // The live card above says "live" or "not visible yet" from this same reading.
  useEffect(() => { if (state) onState?.(state); }, [state, onState]);
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

  // What "Remove domain" did with the DNS (pointed back to the old server, or the records to change by hand).
  const [movedBack, setMovedBack] = useState(null);

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
                      {!r.ok && r.found?.length > 0 && <span className={styles.found}>{T.domainNow(r.found, r.source)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={ws.hint} style={{ margin: 0 }}>{T.domainSameName} {records.some((r) => !r.required) ? T.domainOptionalNote : ''}</p>
          <GoDaddyBox project={project} domain={state.domain} pointsHere={state.connected} onDomain={setState} />
          <div className={styles.accountButtons}>
            <Button size="sm" icon={busy ? Spin : RefreshCw} disabled={busy} onClick={load}>{T.domainCheck}</Button>
            <Button size="sm" icon={Unplug} disabled={busy} onClick={() => setAskRemove(true)}>{T.domainRemove}</Button>
          </div>
        </div>
      )}
      {movedBack && (
        <Alert tone="ok" title={T.backDoneTitle(movedBack.domain, movedBack.ip)}>
          {movedBack.how === 'godaddy' ? T.backDoneAuto(movedBack.keepMinutes) : T.backDoneManual(movedBack.keepMinutes)}
        </Alert>
      )}
      {error && <Alert tone="bad" title="The domain could not be changed">{error}</Alert>}
      <RemoveDomainDialog open={askRemove} project={project} onClose={() => setAskRemove(false)}
        onDone={(r) => { setState(r); setError(null); setMovedBack(r.back ?? null); setAskRemove(false); }} />
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
          <p className={ws.hint} style={{ margin: 0 }}>{saved.box ? T.ptBoxSaved : T.ptSaved}</p>
          <pre className={styles.rules}>{saved.box ? saved.paths.join('\n') : state.rules}</pre>
          {insecure && <Alert tone="warn" title="Not encrypted">{T.ptInsecure}</Alert>}
          <p className={ws.hint} style={{ margin: 0 }}>{T.ptApply}</p>
          <div className={styles.accountButtons}>
            {!saved.box && <Button size="sm" onClick={() => setEditing(true)}>{T.ptEdit}</Button>}
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

const BOX_STEPS = ['unpack', 'find', 'database', 'import', 'website', 'check'];
const GB = 1024;

/**
 * Move logins and data to Remastly: the owner uploads the hosting backup of a WordPress site, Remastly runs its back office
 * in a box (server/src/boxes/), and Logins and data go there instead of the old server.
 */
function BoxCard({ project, onChange }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [ask, setAsk] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      setCard(await api.getBox(project.id));
    } catch (err) {
      setError(err.message);
    }
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const status = card?.box.status;
  // While the box is being made, its steps are followed.
  useEffect(() => {
    if (status !== 'starting') return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [status, load]);
  const wasStarting = useRef(false);
  useEffect(() => {
    if (wasStarting.current && status && status !== 'starting') onChange();
    wasStarting.current = status === 'starting';
  }, [status, onChange]);

  async function act(call) {
    setBusy(true);
    setError(null);
    try {
      setCard(await call());
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addFiles(e) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    setError(null);
    for (const file of files) {
      setUploading({ name: file.name, pct: 0 });
      try {
        setCard(await api.uploadBoxFile(project.id, file, (f) => setUploading({ name: file.name, pct: Math.round(f * 100) })));
      } catch (err) {
        setError(err.message);
        break;
      }
    }
    setUploading(null);
  }

  async function confirm() {
    const what = ask;
    setAsk(null);
    if (what === 'replace') await act(() => api.startBox(project.id, true));
    if (what === 'remove' && (await act(() => api.removeBox(project.id)))) await onChange();
  }

  if (!card) return error ? <Alert tone="bad" title="The back office could not be loaded">{error}</Alert> : null;
  const { box } = card;
  const hasBox = status === 'running' || status === 'stopped';
  if (!card.available && !hasBox) {
    return (
      <Card icon={Archive} title={T.boxTitle} sub={T.boxSub}>
        <p className={ws.hint} style={{ margin: 0 }}>{T.boxUnavailable}</p>
        {card.setup && (
          <ol className={styles.setupSteps}>
            {card.setup.map((s) => (
              <li key={s.why}>
                <span>{s.why}</span>
                {s.command && <span className={styles.value}><code className={styles.rules}>{s.command}</code> <CopyButton text={s.command} /></span>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    );
  }

  const fileList = box.files.length > 0 && (
    <ul className={styles.history}>
      {box.files.map((f) => (
        <li key={f.name}>
          <span>{f.name}</span>
          <span className={ws.hint} style={{ margin: 0 }}>{size(f.bytes)}</span>
          {status !== 'starting' && (
            <button type="button" className={styles.copy} disabled={busy || Boolean(uploading)} onClick={() => act(() => api.removeBoxFile(project.id, f.name))}>
              <Trash2 size={13} aria-hidden="true" /> {T.boxRemoveFile}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
  const chooser = (label) => (
    <>
      <Button size="sm" icon={uploading ? Spin : Upload} disabled={busy || Boolean(uploading)} onClick={() => fileInput.current?.click()}>
        {uploading ? T.boxUploading(uploading.name, uploading.pct) : label}
      </Button>
      <input ref={fileInput} type="file" multiple accept=".gz,.tgz,.tar,.zip,.sql" hidden onChange={addFiles} />
    </>
  );

  return (
    <Card icon={Archive} title={T.boxTitle} sub={T.boxSub}>
      <div className={styles.domainBody}>
        {status === 'starting' && (
          <StepList steps={BOX_STEPS.map((k, i) => {
            const at = BOX_STEPS.indexOf(box.step);
            return { key: k, title: T.boxSteps[k], state: i < at ? 'done' : i === at ? 'active' : 'pending' };
          })} />
        )}

        {hasBox && (
          <>
            <p className={styles.confirmTitle}>{T.boxRunningTitle}</p>
            {box.site && <p className={ws.hint} style={{ margin: 0 }}>{T.boxFacts(box.site)}</p>}
            {status === 'stopped' && <Alert tone="bad" title="Not running">{T.boxStopped}</Alert>}
            {box.site?.warnings.map((w) => <Alert key={w} tone="warn" title="Check this">{w}</Alert>)}
            {card.usedForLogins ? (
              <p className={ws.hint} style={{ margin: 0 }}><Check size={14} aria-hidden="true" /> {T.boxUsed}</p>
            ) : (
              <>
                <div className={styles.accountButtons}>
                  <Button variant="primary" size="sm" disabled={busy} onClick={async () => { if (await act(() => api.useBox(project.id))) await onChange(); }}>{T.boxUse}</Button>
                </div>
                <p className={ws.hint} style={{ margin: 0 }}>{T.boxUseText}</p>
              </>
            )}
            <p className={ws.hint} style={{ margin: 0 }}>{T.boxNotYet}</p>
            {fileList}
            <div className={styles.accountButtons}>
              {box.files.length > 0
                ? <Button size="sm" disabled={busy || Boolean(uploading)} onClick={() => setAsk('replace')}>{T.boxReplace}</Button>
                : chooser(T.boxReplace)}
              <Button size="sm" icon={Trash2} disabled={busy} onClick={() => setAsk('remove')}>{T.boxRemove}</Button>
            </div>
          </>
        )}

        {!hasBox && status !== 'starting' && (
          <>
            <p className={styles.confirmTitle}>{T.boxHowTitle}</p>
            <ul className={styles.howList}>
              <li>{T.boxHowCpanel}</li>
              <li>{T.boxHowOther}</li>
            </ul>
            <Alert tone="warn" title="When">{T.boxTiming}</Alert>
            {status === 'failed' && box.error && <Alert tone="bad" title={T.boxFailedTitle}>{box.error}</Alert>}
            {fileList}
            <div className={styles.accountButtons}>
              {chooser(T.boxChoose)}
              {box.files.length > 0 && (
                <Button variant="primary" size="sm" icon={busy ? Spin : undefined} disabled={busy || Boolean(uploading)} onClick={() => act(() => api.startBox(project.id))}>
                  {status === 'failed' ? T.boxTryAgain : T.boxStart}
                </Button>
              )}
            </div>
            <p className={ws.hint} style={{ margin: 0 }}>{T.boxFilesHelp(card.limits.files, Math.round(card.limits.uploadMB / GB))}</p>
          </>
        )}
        {error && <Alert tone="bad" title="Not done">{error}</Alert>}
      </div>
      <ConfirmDialog open={Boolean(ask)} onClose={() => setAsk(null)} title={ask === 'remove' ? T.boxRemoveTitle : T.boxReplaceTitle}
        confirmLabel={ask === 'remove' ? T.boxRemove : T.boxReplace} danger onConfirm={confirm}>
        {ask === 'remove' ? T.boxRemoveText : T.boxReplaceText}
      </ConfirmDialog>
    </Card>
  );
}

const APP_STEPS = ['download', 'install', 'build', 'start', 'check'];

/** What GitHub sent back in the address when the app came back from it (Run my app on Remastly), read once. */
function takeGitHubReturn() {
  const q = new URLSearchParams(window.location.search);
  const github = q.get('github');
  if (!github) return null;
  q.delete('github');
  const message = q.get('message');
  q.delete('message');
  window.history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}${window.location.hash}`);
  return { github, message };
}

/**
 * Run my app on Remastly: the website's own code (from GitHub) run on Remastly's server with its settings, and "Logins and
 * data" sent to it, so sign-in and the pages after it keep working once the old server is switched off.
 */
function AppCard({ project, onChange }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(() => takeGitHubReturn());
  const [busy, setBusy] = useState(false);
  const [repos, setRepos] = useState(null);
  const [repoChoice, setRepoChoice] = useState('');
  const [branch, setBranch] = useState('');
  // What the last save stored and skipped ({ saved, empty }), until the next action.
  const [saved, setSaved] = useState(null);
  const [askRemove, setAskRemove] = useState(false);

  const load = useCallback(async () => {
    try {
      setCard(await api.getApp(project.id));
    } catch (err) {
      setError(err.message);
    }
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const status = card?.app.status;
  const connected = card?.github?.connected;
  // The repositories to choose from, once GitHub is connected and no repository is chosen yet.
  useEffect(() => {
    if (!connected || status !== 'empty') return;
    // Every repository the person's GitHub lets Remastly read, for every website: none is chosen until they choose it here.
    api.githubRepos().then(setRepos, (err) => setError(err.message));
  }, [connected, status]);
  // While the app is being made, its steps are followed; the cards above follow when it is done.
  useEffect(() => {
    if (status !== 'starting') return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [status, load]);
  const wasStarting = useRef(false);
  useEffect(() => {
    if (wasStarting.current && status && status !== 'starting') onChange();
    wasStarting.current = status === 'starting';
  }, [status, onChange]);

  async function act(call) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await call();
      if (next?.app) setCard(next);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  // To GitHub and back: Remastly answers with the address; the browser goes there.
  const goTo = (call) => act(async () => { window.location.assign((await call()).url); });
  async function setUpGitHub() {
    await act(async () => {
      const { action, manifest } = await api.setupGitHub({ returnTo: window.location.href });
      // GitHub takes the app's description as a form posted by the browser.
      const form = document.createElement('form');
      form.method = 'post';
      form.action = action;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'manifest';
      field.value = manifest;
      form.append(field);
      document.body.append(form);
      form.submit();
    });
  }

  if (!card) return error ? <Alert tone="bad" title="The app card could not be loaded">{error}</Alert> : null;
  const { app, github } = card;
  const hasApp = status === 'running' || status === 'stopped';
  const noticeAlert = notice && (
    <Alert tone={notice.github === 'error' ? 'bad' : 'ok'} title="GitHub">
      {notice.github === 'error' ? notice.message : notice.github === 'ready' ? T.appReady : notice.github === 'installed' ? T.appInstalled : notice.github === 'app-made' ? T.appGithubMade : T.appConnected(connected?.login ?? '')}
    </Alert>
  );

  if (!card.available && !hasApp) {
    return (
      <Card icon={Code} title={T.appTitle} sub={T.appSub}>
        <p className={ws.hint} style={{ margin: 0 }}>{T.appUnavailable}</p>
        {card.setup && <p className={ws.hint} style={{ margin: 0 }}>{T.appSetupAbove}</p>}
      </Card>
    );
  }

  /** Saves the rows' values (AppSettings); the card says what was stored. @param {Record<string, string>} values */
  async function saveSettings(values) {
    let result = null;
    const ok = await act(async () => {
      const next = await api.setAppSettings(project.id, { values });
      result = next.saved;
      return next;
    });
    if (ok) setSaved(result);
    return ok;
  }

  return (
    <Card icon={Code} title={T.appTitle} sub={T.appSub}>
      <div className={styles.domainBody}>
        {noticeAlert}
        {!github?.ready && (github?.canSetUp ? (
          <>
            <p className={ws.hint} style={{ margin: 0 }}>{T.appSetupText}</p>
            <div className={styles.accountButtons}>
              <Button variant="primary" size="sm" icon={busy ? Spin : undefined} disabled={busy} onClick={setUpGitHub}>{T.appSetupGitHub}</Button>
            </div>
          </>
        ) : <p className={ws.hint} style={{ margin: 0 }}>{T.appNotSetUp}</p>)}

        {github?.ready && !connected && (
          <>
            <p className={ws.hint} style={{ margin: 0 }}>{T.appConnectText}</p>
            <div className={styles.accountButtons}>
              <Button variant="primary" size="sm" icon={busy ? Spin : undefined} disabled={busy} onClick={() => goTo(() => api.connectGitHub({ returnTo: window.location.href }))}>{T.appConnect}</Button>
            </div>
          </>
        )}

        {connected && status === 'empty' && (
          <>
            {connected.installations.length === 0 || repos?.repos.length === 0 ? (
              <p className={ws.hint} style={{ margin: 0 }}>{connected.installations.length === 0 ? T.appNoInstall : T.appNoRepos}</p>
            ) : repos && (
              <div className={styles.godaddyFields}>
                <label className={form.field}>
                  <span className={form.label}>{T.appRepoLabel}</span>
                  <select className={form.input} value={repoChoice} onChange={(e) => {
                    setRepoChoice(e.target.value);
                    setBranch(repos.repos.find((r) => `${r.installationId} ${r.fullName}` === e.target.value)?.branch ?? '');
                  }}>
                    <option value="">{T.appRepoNone}</option>
                    {repos.repos.map((r) => <option key={`${r.installationId} ${r.fullName}`} value={`${r.installationId} ${r.fullName}`}>{r.fullName}</option>)}
                  </select>
                </label>
                <label className={form.field}>
                  <span className={form.label}>{T.appBranchLabel}</span>
                  <input className={form.input} value={branch} onChange={(e) => setBranch(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
              </div>
            )}
            {repos?.repos.length > 0 && <p className={ws.hint} style={{ margin: 0 }}>{T.appRepoHelp}</p>}
            {repos?.problems?.map((p) => <Alert key={p} tone="warn" title="GitHub">{p}</Alert>)}
            <div className={styles.accountButtons}>
              {repos?.repos.length > 0 && (
                <Button variant="primary" size="sm" icon={busy ? Spin : undefined} disabled={busy || !repoChoice || !branch.trim()} onClick={() => {
                  const [installationId, fullName] = repoChoice.split(' ');
                  act(() => api.chooseAppRepo(project.id, { installationId: Number(installationId), fullName, branch: branch.trim() }));
                }}>{busy ? T.appReading : T.appChooseRepo}</Button>
              )}
              <Button size="sm" icon={ExternalLink} disabled={busy} onClick={() => goTo(() => api.connectGitHub({ returnTo: window.location.href, install: true }))}>{T.appInstall}</Button>
            </div>
          </>
        )}

        {app.repo && app.app && (
          <>
            <p className={styles.confirmTitle}>{hasApp ? T.appRunningTitle : T.appFacts(app)}</p>
            {hasApp && <p className={ws.hint} style={{ margin: 0 }}>{T.appFacts(app)}</p>}
            {status === 'stopped' && <Alert tone="bad" title="Not running">{T.appStopped}</Alert>}
            {/* A repository with several apps (a frontend and a backend, a workspace): which one runs here. */}
            {app.app.folders?.length > 1 && status !== 'starting' && (
              <label className={form.field}>
                <span className={form.label}>{T.appFolderLabel}</span>
                <select className={form.input} value={app.app.folder} disabled={busy}
                  onChange={(e) => act(() => api.chooseAppRepo(project.id, { installationId: app.repo.installationId, fullName: app.repo.fullName, branch: app.repo.branch, folder: e.target.value }))}>
                  {app.app.folders.map((f) => <option key={f.folder} value={f.folder}>{`${f.folder || T.appFolderTop}${f.framework === 'next' ? ' (Next.js)' : ''}`}</option>)}
                </select>
                <span className={ws.hint} style={{ margin: 0 }}>{T.appFolderHelp}</span>
              </label>
            )}
            {app.app.warnings.map((w) => <Alert key={w} tone="warn" title="Check this">{w}</Alert>)}

            {status === 'starting' && (
              <>
                <StepList steps={APP_STEPS.map((k, i) => {
                  const at = APP_STEPS.indexOf(app.step);
                  return { key: k, title: T.appSteps[k], state: i < at ? 'done' : i === at ? 'active' : 'pending' };
                })} />
                <p className={ws.hint} style={{ margin: 0 }}>{T.appStepsNote}</p>
              </>
            )}

            {app.error && status !== 'starting' && (
              <Alert tone={hasApp ? 'warn' : 'bad'} title={T.appFailedTitle}>
                {app.stoppedFor?.length > 0 && <p style={{ margin: '0 0 6px' }}><strong>{T.appStoppedFor(app.stoppedFor)}</strong></p>}
                {app.error}
                {app.log && (
                  <details>
                    <summary>{T.appLogTitle}</summary>
                    <pre className={styles.rules} style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{app.log}</pre>
                  </details>
                )}
              </Alert>
            )}

            {hasApp && (card.usedForLogins ? (
              <p className={ws.hint} style={{ margin: 0 }}><Check size={14} aria-hidden="true" /> {T.appUsed}</p>
            ) : (
              <>
                <div className={styles.accountButtons}>
                  <Button variant="primary" size="sm" disabled={busy} onClick={async () => { if (await act(() => api.useApp(project.id))) await onChange(); }}>{T.appUse}</Button>
                </div>
                <p className={ws.hint} style={{ margin: 0 }}>{T.appUseText(app.app.paths)}</p>
              </>
            ))}

            {status !== 'starting' && (
              <>
                <p className={styles.confirmTitle}>{T.appSettingsTitle}</p>
                <p className={ws.hint} style={{ margin: 0 }}>{T.appSettingsText}</p>
                <AppSettings app={app} busy={busy} onSave={saveSettings}
                  onRemove={(name) => act(() => api.setAppSettings(project.id, { values: { [name]: '' } }))} />
                {saved && (
                  <Alert tone={saved.saved.length && !saved.empty.length ? 'ok' : 'warn'} title={T.appSavedTitle(saved)}>{T.appSaved(saved)}</Alert>
                )}
                {app.missing.length > 0 && <p className={ws.hint} style={{ margin: 0 }}>{T.appMissingNote(app.missing.length)}</p>}
                {app.unused?.length > 0 && <Alert tone="warn" title="Check this">{T.appUnusedNote(app.unused)}</Alert>}
                <AppGithubMaker project={project} app={app} domain={card.domain} onChange={setCard} />
                <OldServerImport project={project} wanted={app.app.settings?.length ?? 0} onCopied={(next) => { setCard(next); setSaved(next.saved); }} />
                <p className={ws.hint} style={{ margin: 0 }}>{T.appDatabaseNote}</p>
                <div className={styles.accountButtons}>
                  <Button variant="primary" size="sm" icon={busy ? Spin : Rocket} disabled={busy} onClick={() => act(() => api.startApp(project.id))}>
                    {hasApp ? T.appUpdate : status === 'failed' ? T.appTryAgain : T.appStart}
                  </Button>
                  <Button size="sm" icon={Trash2} disabled={busy} onClick={() => setAskRemove(true)}>{T.appRemove}</Button>
                </div>
              </>
            )}
          </>
        )}

        {connected && (
          <p className={ws.hint} style={{ margin: 0 }}>
            {T.appConnected(connected.login)}{' '}
            <button type="button" className={styles.copy} disabled={busy} onClick={() => act(async () => { await api.disconnectGitHub(); await load(); })}>{T.appDisconnect}</button>
          </p>
        )}
        {error && <Alert tone="bad" title="Not done">{error}</Alert>}
      </div>
      <ConfirmDialog open={askRemove} onClose={() => setAskRemove(false)} title={T.appRemoveTitle} confirmLabel={T.appRemove} danger
        onConfirm={async () => { setAskRemove(false); if (await act(() => api.removeApp(project.id))) await onChange(); }}>
        {T.appRemoveText}
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

/** The one-time server setup for Remastly's own hosting (owner only): files and steps with this Remastly's own folders. */
function ServerSetupDialog({ open, onClose }) {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    api.getServerSetup().then(setSetup, (err) => setError(err.message));
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={T.serverSetupTitle} description={T.serverSetupIntro} footer={<Button onClick={onClose}>Close</Button>}>
      {error && <Alert tone="bad" title="Could not load the setup">{error}</Alert>}
      {setup && (
        <div className={styles.domainBody}>
          <p className={ws.hint} style={{ margin: 0 }}>{T.serverSetupStatus(setup.status)}</p>
          {setup.emailMissing && <Alert tone="warn" title="Owner email">{T.serverSetupEmail}</Alert>}
          <p className={styles.confirmTitle}>{T.serverSetupSteps}</p>
          <ol className={styles.setupSteps}>
            {setup.steps.map((s) => (
              <li key={s.why}>
                <span>{s.why}</span>
                {s.command.startsWith('sudo') && <span className={styles.value}><code className={styles.rules}>{s.command}</code> <CopyButton text={s.command} /></span>}
              </li>
            ))}
          </ol>
          <p className={styles.confirmTitle}>{T.serverSetupEnv}</p>
          <span className={styles.value}><code className={styles.rules}>{setup.env.join('\n')}</code> <CopyButton text={setup.env.join('\n')} /></span>
          <p className={styles.confirmTitle}>{T.serverSetupFiles}</p>
          {setup.files.map((f) => (
            <details key={f.path} className={styles.setupFile}>
              <summary><code>{f.path}</code> · {f.why}</summary>
              <CopyButton text={f.content} />
              <pre className={styles.rules}>{f.content}</pre>
            </details>
          ))}
        </div>
      )}
    </Modal>
  );
}
