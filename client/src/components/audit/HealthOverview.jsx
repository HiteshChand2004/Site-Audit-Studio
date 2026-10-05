import { Bot, Gauge, Search, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { Card } from '../common/Surface.jsx';
import { ScoreRing, Pill } from '../common/Score.jsx';
import InfoTip from '../common/InfoTip.jsx';
import { AEO, HEALTH, METRICS, rating } from '../../copy.js';
import { plural } from '../../format.js';
import styles from './HealthOverview.module.css';

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

// Speed measurements: good / needs work thresholds (Google's own).
const SPEED = [
  { key: 'lcp', field: 'lcp', fmt: fmtMs, good: 2500, poor: 4000 },
  { key: 'tti', field: 'loadTime', fmt: fmtMs, good: 3000, poor: 5000 },
  { key: 'tbt', field: 'tbt', fmt: fmtMs, good: 200, poor: 600 },
  { key: 'size', field: 'pageSize', fmt: fmtBytes, good: 1.6 * 1024 * 1024, poor: 4 * 1024 * 1024 },
];
const speedRating = (v, m) => (v == null ? { label: 'Not measured', tone: 'neutral' } : v <= m.good ? { label: 'Good', tone: 'ok' } : v <= m.poor ? { label: 'Needs work', tone: 'warn' } : { label: 'Poor', tone: 'bad' });

const CARDS = [
  { key: 'performance', icon: Gauge },
  { key: 'seo', icon: Search },
  { key: 'accessibility', icon: Users },
  { key: 'best-practices', field: 'bestPractices', icon: ShieldCheck },
];

/** Ready for AI answers: the share of its checks that pass (a warning counts half). */
export function aeoScore(items = []) {
  if (!items.length) return null;
  const points = items.reduce((n, i) => n + (i.status === 'pass' ? 1 : i.status === 'warn' ? 0.5 : 0), 0);
  return Math.round((points / items.length) * 100);
}

/** A few plain sentences about the site, from its scores and findings. */
export function summarize(audit, device) {
  const out = [];
  const perf = audit.scores?.[device]?.performance;
  if (perf != null) {
    const r = rating(perf);
    out.push(`${r.tone === 'ok' ? 'The site loads fast' : r.tone === 'warn' ? 'The site loads at an acceptable speed but could be faster' : 'The site loads slowly'}.`);
  }
  const seo = audit.scores?.[device]?.seo;
  if (seo != null) out.push(seo >= 90 ? 'Google can read it well.' : 'Some basics that help Google list it are missing.');
  const a11y = (audit.accessibility ?? []).reduce((n, a) => n + (a.count ?? 1), 0);
  out.push(a11y ? `${plural(a11y, 'thing')} on the homepage make${a11y === 1 ? 's' : ''} it harder for people with disabilities to use.` : 'No accessibility problems were found on the homepage.');
  const broken = audit.brokenLinks?.broken?.length ?? 0;
  if (broken) out.push(`${plural(broken, 'link')} lead${broken === 1 ? 's' : ''} nowhere.`);
  return out;
}

/**
 * "At a glance": the summary, the health cards and speed in everyday words. Desktop only for now (the check measures
 * the computer view); an older check without computer numbers shows its phone numbers.
 */
export default function HealthOverview({ audit }) {
  const device = audit.scores?.desktop || !audit.scores?.mobile ? 'desktop' : 'mobile';
  const scores = audit.scores?.[device] ?? null;
  const metrics = audit.metricsByDevice?.[device] ?? (device === 'mobile' ? audit.metrics : null);
  const primary = audit.techStack?.find((t) => t.id !== 'custom' && t.confidence != null);
  const aeo = aeoScore(audit.aeo);

  return (
    <div className={styles.wrap}>
      <Card
        icon={Sparkles}
        title="At a glance"
        sub={`${primary ? `Built with ${primary.name}. ` : ''}Measured on a computer.`}
      >
        <p className={styles.summary}>{summarize(audit, device).join(' ')}</p>

        <div className={styles.cards}>
          {CARDS.map(({ key, field, icon: Icon }) => {
            const h = HEALTH[key];
            const score = scores?.[field ?? key] ?? null;
            return (
              <div key={key} className={styles.card}>
                <div className={styles.cardHead}>
                  <Icon size={16} aria-hidden="true" />
                  <span className={styles.cardTitle}>{h.title}</span>
                  <InfoTip label={h.title}>
                    {h.explain} <em>({h.expert})</em>
                  </InfoTip>
                </div>
                <ScoreRing score={score} label={h.title} />
                <p className={styles.question}>{h.question}</p>
              </div>
            );
          })}
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <Bot size={16} aria-hidden="true" />
              <span className={styles.cardTitle}>{AEO.title}</span>
              <InfoTip label={AEO.title} align="end">
                {AEO.explain} <em>({AEO.expert}; share of its checks that pass)</em>
              </InfoTip>
            </div>
            <ScoreRing score={aeo} label={AEO.title} />
            <p className={styles.question}>Can AI assistants quote it correctly?</p>
          </div>
        </div>
        {!scores && <p className={styles.note}>The speed test did not finish; check the site again to measure it.</p>}
      </Card>

      <Card icon={Gauge} title="Speed in everyday words" sub="The homepage on a computer.">
        <ul className={styles.speed}>
          {SPEED.map((m) => {
            const value = metrics?.[m.field] ?? null;
            const r = speedRating(value, m);
            const text = METRICS[m.key];
            return (
              <li key={m.key}>
                <span className={styles.speedTitle}>
                  {text.title}
                  <InfoTip label={text.title}>
                    {text.explain} <em>({text.expert})</em>
                  </InfoTip>
                </span>
                <span className={styles.speedValue}>{value == null ? '–' : m.fmt(value)}</span>
                <Pill tone={r.tone}>{r.label}</Pill>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
