import { useState } from 'react';
import { Copy, ExternalLink, Link2, RefreshCw, Unlink } from 'lucide-react';
import Button from '../common/Button.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import { Alert, Card } from '../common/Surface.jsx';
import form from '../common/Form.module.css';
import { timeAgo } from '../../format.js';
import { api } from '../../api/client.js';
import styles from './AfterBuild.module.css';

const HOSTING = 'To put the site on your own web address (like yourbusiness.com), download it and upload it to a web host such as Netlify or Cloudflare Pages.';

/** A link to the finished site anyone can open, for showing it and checking it on a phone; not hosting. */
export default function ShareSite({ run, onRun }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);
  const shared = run.published;
  const link = shared ? new URL(shared.url, window.location.origin).href : '';

  const act = async (work) => {
    setBusy(true);
    setError('');
    try {
      onRun(await work());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('The link could not be copied. Select it and copy it by hand.');
    }
  };

  return (
    <Card title="Share your site" sub="A link anyone can open: send it to people for their opinion, or open it on your phone to check the site.">
      {shared ? (
        <div className={styles.share}>
          <div className={styles.linkRow}>
            <input className={`${form.input} ${styles.linkInput}`} readOnly value={link} aria-label="Link to your site" onFocus={(e) => e.target.select()} />
            <Button icon={Copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            <a className={styles.linkButton} href={shared.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true" />Open</a>
          </div>
          <p className={styles.note}>Shared {timeAgo(shared.at)}. Anyone with the link can see the site; nobody can change it.</p>
          {shared.outdated && (
            <Alert
              tone="warn"
              title="You changed the site after sharing it"
              action={<Button size="sm" variant="primary" icon={RefreshCw} disabled={busy} onClick={() => act(() => api.publishBuild(run.id))}>Update the link</Button>}
            >
              The link still shows the earlier version until you update it.
            </Alert>
          )}
          <div>
            <Button size="sm" variant="ghost" icon={Unlink} disabled={busy} onClick={() => setStopping(true)}>Stop sharing</Button>
          </div>
        </div>
      ) : (
        <div className={styles.share}>
          <Button variant="primary" icon={Link2} disabled={busy || run.status !== 'done'} onClick={() => act(() => api.publishBuild(run.id))}>
            {busy ? 'Making the link…' : 'Get a share link'}
          </Button>
        </div>
      )}
      <p className={styles.note}>This link is for sharing and checking. {HOSTING}</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <ConfirmDialog
        open={stopping}
        onClose={() => setStopping(false)}
        title="Stop sharing this site?"
        confirmLabel="Stop sharing"
        danger
        onConfirm={() => act(() => api.unpublishBuild(run.id))}
      >
        <p>The link stops working for everyone who has it. You can share the site again later; it then gets a new link.</p>
      </ConfirmDialog>
    </Card>
  );
}

