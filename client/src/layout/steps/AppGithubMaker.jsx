import { useState } from 'react';
import { ExternalLink, Github, Loader2 } from 'lucide-react';
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
// The permissions GitHub knows under these names (server apps/appGithub.js AREAS); "workflows" exists only as write.
const AREAS = ['contents', 'issues', 'pull_requests', 'checks', 'statuses', 'actions', 'workflows', 'deployments'];
const levelsOf = (area) => (area === 'workflows' ? ['write'] : ['read', 'write']);

/**
 * "Make its GitHub App": for an app whose code signs in to GitHub as a GitHub App of its own (it reads an app ID and a private
 * key). GitHub makes the app from the description Remastly sends (the browser posts it, as for Remastly's own app), the person
 * installs it, and the settings for its ID, key, installation… are filled. Optional, next to typing or copying them.
 * @param {{ project: any, app: any, domain: string, onChange: (next: any) => void }} props  app: the card's app state
 */
export default function AppGithubMaker({ project, app, domain, onChange }) {
  const roles = app.githubRoles;
  const use = app.app?.github;
  const made = app.githubApp;
  const repoOwner = app.repo?.fullName?.split('/')[0] ?? '';
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState('org');
  const [org, setOrg] = useState(repoOwner);
  const [permissions, setPermissions] = useState(() => ({ ...(use?.permissions ?? {}) }));
  const [events, setEvents] = useState(() => use?.events ?? []);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [askForget, setAskForget] = useState(false);

  if (!roles) return null;
  // The settings this app reads for its GitHub App, in the order a person thinks of them.
  const names = ['appId', 'privateKey', 'privateKeyBase64', 'installationId', 'clientId', 'clientSecret', 'webhookSecret', 'owner'].flatMap((r) => roles[r]);
  const takesHooks = roles.webhookSecret.length > 0;
  const alreadySet = roles.appId.some((n) => app.settingsSet.includes(n));

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
  async function toGitHub() {
    await run(async () => {
      const { action, manifest } = await api.makeAppGithubApp(project.id, {
        org: owner === 'org' ? org.trim() : '', permissions, events: takesHooks ? events : [], webhookUrl: takesHooks ? webhookUrl.trim() : '',
        returnTo: window.location.href,
      });
      // GitHub takes the app's description as a form posted by the browser.
      const f = document.createElement('form');
      f.method = 'post';
      f.action = action;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'manifest';
      field.value = manifest;
      f.append(field);
      document.body.append(f);
      f.submit();
    });
  }
  async function install() {
    const r = await run(() => api.installAppGithubApp(project.id, { returnTo: window.location.href }));
    if (r) window.location.assign(r.url);
  }
  async function forget() {
    const next = await run(() => api.forgetAppGithubApp(project.id));
    if (next) {
      setAskForget(false);
      onChange(next);
    }
  }

  if (made) {
    return (
      <div className={styles.confirm}>
        <p className={styles.confirmTitle}>{T.ghMadeTitle(made)}</p>
        <p className={ws.hint} style={{ margin: 0 }}>{made.installed ? T.ghMadeInstalled(made) : T.ghMadeNotInstalled}</p>
        <div className={styles.accountButtons}>
          {!made.installed && <Button variant="primary" size="sm" icon={busy ? Spin : undefined} disabled={busy} onClick={install}>{T.ghInstall}</Button>}
          <a className={styles.copy} href={made.htmlUrl} target="_blank" rel="noreferrer">{T.ghOpen} <ExternalLink size={12} aria-hidden="true" /></a>
          {askForget ? (
            <>
              <span className={ws.hint} style={{ margin: 0 }}>{T.ghForgetText}</span>
              <Button size="sm" disabled={busy} onClick={forget}>{T.ghForgetYes}</Button>
              <Button size="sm" disabled={busy} onClick={() => setAskForget(false)}>{T.oldCancel}</Button>
            </>
          ) : <Button size="sm" disabled={busy} onClick={() => setAskForget(true)}>{T.ghForget}</Button>}
        </div>
        {error && <Alert tone="bad" title={T.oldFailedTitle}>{error}</Alert>}
      </div>
    );
  }

  if (!open) {
    return (
      <div className={styles.accountButtons} style={{ alignItems: 'center' }}>
        <Button size="sm" icon={Github} onClick={() => setOpen(true)}>{T.ghOpenForm}</Button>
        <span className={ws.hint} style={{ margin: 0 }}>{T.ghOptional(roles.appId[0])}</span>
      </div>
    );
  }

  const readyToGo = owner === 'me' || /^[A-Za-z0-9-]{1,39}$/.test(org.trim());
  return (
    <div className={styles.confirm}>
      <p className={styles.confirmTitle}>{T.ghTitle}</p>
      <p className={ws.hint} style={{ margin: 0 }}>{T.ghText(names)}</p>
      {alreadySet && <Alert tone="warn" title="Check this">{T.ghAlreadySet(roles.appId[0])}</Alert>}

      <Segmented label={T.ghOwner} size="sm" value={owner} onChange={setOwner}
        options={[{ value: 'org', label: T.ghOwnerOrg }, { value: 'me', label: T.ghOwnerMe }]} />
      {owner === 'org' && (
        <label className={form.field}>
          <span className={form.label}>{T.ghOrg}</span>
          <input className={form.input} value={org} onChange={(e) => setOrg(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} placeholder="my-company" />
          <span className={ws.hint} style={{ margin: 0 }}>{T.ghOrgHelp}</span>
        </label>
      )}

      <p className={form.label} style={{ margin: 0 }}>{T.ghPermissions}</p>
      <p className={ws.hint} style={{ margin: 0 }}>{use?.from === 'app.yml' ? T.ghFromYml : Object.keys(use?.permissions ?? {}).length ? T.ghFromCode : T.ghNoneFound}</p>
      <div className={styles.tableWrap}>
        <table className={styles.records}>
          <tbody>
            {AREAS.map((area) => (
              <tr key={area}>
                <td>
                  {T.ghAreas[area]}
                  {use?.evidence?.[area]?.length > 0 && <span className={styles.found}>{T.ghSeen(use.evidence[area])}</span>}
                </td>
                <td>
                  <select className={form.input} aria-label={T.ghAreas[area]} value={permissions[area] ?? ''} disabled={busy}
                    onChange={(e) => setPermissions((p) => {
                      const next = { ...p };
                      if (e.target.value) next[area] = e.target.value;
                      else delete next[area];
                      return next;
                    })}>
                    <option value="">{T.ghLevelNone}</option>
                    {levelsOf(area).map((l) => <option key={l} value={l}>{T.ghLevels[l]}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {takesHooks && (
        <>
          <label className={form.field}>
            <span className={form.label}>{T.ghWebhook(roles.webhookSecret[0])}</span>
            <input className={form.input} value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} placeholder={`https://${domain}/…`} />
            <span className={ws.hint} style={{ margin: 0 }}>{T.ghWebhookHelp}</span>
          </label>
          {webhookUrl.trim() && (
            <fieldset className={form.field} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className={form.label}>{T.ghEvents}</legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2) var(--sp-4)' }}>
                {T.ghEventList.map((ev) => (
                  <label key={ev} className={styles.sourceItem}>
                    <input type="checkbox" checked={events.includes(ev)} disabled={busy}
                      onChange={(e) => setEvents((list) => (e.target.checked ? [...list, ev] : list.filter((x) => x !== ev)))} />
                    <code>{ev}</code>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </>
      )}

      <p className={ws.hint} style={{ margin: 0 }}>{T.ghSafety}</p>
      <div className={styles.accountButtons}>
        <Button variant="primary" size="sm" icon={busy ? Spin : ExternalLink} disabled={busy || !readyToGo} onClick={toGitHub}>{T.ghGo}</Button>
        <Button size="sm" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>{T.oldCancel}</Button>
      </div>
      {error && <Alert tone="bad" title={T.oldFailedTitle}>{error}</Alert>}
    </div>
  );
}
