import { useState } from 'react';
import { Download, ExternalLink, Loader2, Monitor, Play, RotateCw, Smartphone, Sparkles } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import CountUp from '../components/common/CountUp.jsx';
import InfoTip from '../components/common/InfoTip.jsx';
import { Segmented } from '../components/common/Tabs.jsx';
import { BrowserShot, SiteIcon } from '../components/site/Site.jsx';
import { RECREATE_STACKS, hostOf, stackById } from '../constants.js';
import { HEALTH, RESULT_STATUS, rating } from '../copy.js';
import { plural, timeAgo } from '../format.js';
import { api } from '../api/client.js';
import { outputsOf } from '../stacks.js';
import { copyShot, isReal, originalShot, outcomeCounts, platformOf, scoresOf } from '../siteData.js';
import { isJobActive, useProjects } from '../store/useProjects.js';
import styles from './SiteHero.module.css';

const Spinner = (p) => <Loader2 {...p} className={styles.spin} />;

const SCORES = [
  ['performance', 'performance'],
  ['seo', 'seo'],
  ['accessibility', 'accessibility'],
  ['bestPractices', 'best-practices'],
];

/** One headline score: the copy's value large, the original's beside it, and both as bars. */
function Score({ health, before, after, index }) {
  const h = HEALTH[health];
  const main = after ?? before;
  const delta = after != null && before != null ? after - before : null;
  const tone = rating(main).tone;
  return (
    <div className={styles.score} style={{ animationDelay: `${160 + index * 60}ms` }}>
      <span className={styles.scoreLabel}>
        {h.title}
        <InfoTip label={h.title}>
          {h.explain} <em>({h.expert})</em>
        </InfoTip>
      </span>
      <span className={styles.scoreRow}>
        <span className={`${styles.scoreValue} tabular`} data-tone={tone}>
          {main == null ? '–' : <CountUp value={main} />}
        </span>
        {delta != null && (
          <span className={styles.delta} data-dir={delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}>
            {delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : 'same'}
          </span>
        )}
      </span>
      <span className={styles.bars} aria-hidden="true">
        {after != null && (
          <span className={styles.bar} data-side="new">
            <i style={{ width: `${after}%` }} />
          </span>
        )}
        <span className={styles.bar} data-side="old">
          <i style={{ width: `${before ?? 0}%` }} />
        </span>
      </span>
      <span className={styles.scoreFoot}>{after != null ? `Original ${before ?? '–'}` : 'Original site'}</span>
    </div>
  );
}

/** Why the copy can't be made right now, or null (same rules as the Copy tab). */
function copyBlocker({ audit, project, analyzing }) {
  if (!isReal(audit)) return 'Check the site first: the copy is built from what the check found.';
  if (analyzing) return 'Wait until the check has finished.';
  if (!RECREATE_STACKS.includes(project.stack)) return 'This technology cannot be used yet. Choose another one in the settings.';
  return null;
}

/**
 * The top of a website's dashboard: who it is, a picture of it (and of the copy), the headline scores before → after,
 * what changed, and the next thing to do.
 */
export default function SiteHero({ project, audit, onGo }) {
  const analysis = useProjects((s) => s.analyses[project.id]);
  const job = useProjects((s) => s.recreates[project.id]);
  const reauditJob = useProjects((s) => s.reaudits[project.id]);
  const latest = useProjects((s) => s.recreateResults[project.id]);
  const analyze = useProjects((s) => s.analyze);
  const recreate = useProjects((s) => s.recreate);
  const result = latest?.result ?? null;
  const [device, setDevice] = useState('mobile');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);

  const host = hostOf(project.url);
  const checked = isReal(audit);
  const analyzing = isJobActive(analysis);
  const copying = isJobActive(job);
  const busy = analyzing || copying || isJobActive(reauditJob);
  const platform = platformOf(audit);
  const counts = outcomeCounts(audit);
  const { before, after } = scoresOf(audit, device);
  const shot = originalShot(project.id, audit, result);
  const copy = copyShot(project.id, result);
  const blocker = copyBlocker({ audit, project, analyzing });

  const facts = [
    checked && `Checked ${timeAgo(audit.analyzedAt)}`,
    checked && plural(audit.pagesCrawled ?? 0, 'page') + ' read',
    platform && `Built with ${platform.name}`,
    result && `Copy in ${stackById(result.stack ?? project.stack).short}`,
  ].filter(Boolean);

  const ready = result && outputsOf(result)[project.stack]?.status === 'ready' && result.safety?.safe;
  async function download() {
    if (!ready) return onGo('results');
    setDownloading(true);
    setDownloadError(null);
    try {
      const problem = await api.checkDownload(project.id, result.recreateId, project.stack);
      if (problem) setDownloadError(problem);
      else window.location.assign(api.downloadUrl(project.id, result.recreateId, project.stack));
    } catch (err) {
      setDownloadError(err.message || 'Cannot reach the server.');
    } finally {
      setDownloading(false);
    }
  }

  // The one main action: what moves this website forward now.
  let primary;
  if (analyzing) {
    primary = (
      <Button variant="primary" size="lg" icon={Spinner} onClick={() => onGo('check')}>
        Checking{Number.isFinite(analysis.pct) ? ` · ${analysis.pct} %` : '…'}
      </Button>
    );
  } else if (copying) {
    primary = (
      <Button variant="primary" size="lg" icon={Spinner} onClick={() => onGo('create')}>
        Making the copy{Number.isFinite(job.pct) ? ` · ${job.pct} %` : '…'}
      </Button>
    );
  } else if (!checked) {
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon={Play}
        onClick={() => {
          analyze(project.id);
          onGo('check');
        }}
      >
        Check the site
      </Button>
    );
  } else if (!result) {
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon={Sparkles}
        disabled={Boolean(blocker)}
        title={blocker ?? 'Visits every page and builds a clean copy that fixes what the check found'}
        onClick={() => {
          recreate(project.id);
          onGo('create');
        }}
      >
        Create the copy
      </Button>
    );
  } else {
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon={downloading ? Spinner : Download}
        disabled={downloading || (ready && busy)}
        title={ready ? `Download the ${stackById(project.stack).name} site as a .zip` : 'Choose the technology and download in Results'}
        onClick={download}
      >
        {ready ? 'Download the site' : 'Get the download'}
      </Button>
    );
  }

  return (
    <section className={styles.hero} aria-label={`${host} at a glance`}>
      <div className={styles.top}>
        <div className={styles.identity}>
          <div className={styles.nameRow}>
            <SiteIcon project={project} host={host} size={44} />
            <div className={styles.titles}>
              <h1 className={styles.name}>{host}</h1>
              <a className={styles.url} href={project.url} target="_blank" rel="noopener noreferrer">
                <span className="mono">{project.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                <ExternalLink size={12} aria-hidden="true" />
                <span className="visually-hidden">(opens the live site in a new tab)</span>
              </a>
            </div>
          </div>

          {facts.length > 0 ? (
            <ul className={styles.facts}>
              {facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.lead}>Not checked yet. The first check reads the site, measures its speed and lists what to fix; it takes a minute or two.</p>
          )}

          {counts && (
            <ul className={styles.counts} aria-label="Compared with the original">
              {[
                ['better', counts.better, 'ok', 'better', `${RESULT_STATUS.fixed.explain} Or: ${RESULT_STATUS.improved.explain.toLowerCase()}`],
                ['open', counts.open, counts.open ? 'warn' : 'neutral', 'still open', RESULT_STATUS.open.explain],
                ['regressed', counts.regressed, counts.regressed ? 'bad' : 'neutral', 'got worse', RESULT_STATUS.regressed.explain],
                ['manual', counts.manual, 'neutral', 'for a person', RESULT_STATUS.manual.explain],
              ].map(([id, n, tone, label, tip]) => (
                <li key={id} data-tone={tone}>
                  <button type="button" onClick={() => onGo('results')} title={tip}>
                    <strong className="tabular">
                      <CountUp value={n} />
                    </strong>
                    <span>{label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.actions}>
            {primary}
            {checked && !analyzing && (
              <Button icon={RotateCw} disabled={busy} title={busy ? 'Wait until the running job has finished' : 'Check the live site again'} onClick={() => {
                analyze(project.id);
                onGo('check');
              }}>
                Check again
              </Button>
            )}
          </div>
          {downloadError && (
            <p className={styles.error} role="alert">
              {downloadError}
            </p>
          )}
        </div>

        <div className={styles.media}>
          <BrowserShot src={shot} address={host} alt={`The original ${host}, first screen on a computer`} ratio={16 / 10} size="lg" emptyText={checked ? 'No picture of this check' : 'The first check takes a picture'} />
          {copy && (
            <button type="button" className={styles.copyInset} onClick={() => onGo('compare')} aria-label="Compare the copy with the original">
              <BrowserShot src={copy} alt="" ratio={16 / 10.5} size="sm" />
              <span className={styles.insetLabel}>The copy</span>
            </button>
          )}
        </div>
      </div>

      {checked && (
        <div className={styles.scores}>
          <div className={styles.scoresHead}>
            <span className="eyebrow">{after ? 'Copy vs original' : 'Health of the original'}</span>
            <Segmented
              size="sm"
              label="Measured on"
              value={device}
              onChange={setDevice}
              options={[
                { value: 'mobile', label: 'Phone', icon: Smartphone },
                { value: 'desktop', label: 'Computer', icon: Monitor },
              ]}
            />
          </div>
          <div className={styles.scoreGrid}>
            {SCORES.map(([field, health], i) => (
              <Score key={field} health={health} before={before?.[field] ?? null} after={after?.[field] ?? null} index={i} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
