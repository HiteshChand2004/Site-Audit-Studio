import { useRef } from 'react';
import { StatusIcon } from './Score.jsx';
import styles from './Tabs.module.css';

/**
 * The step tabs: each tab has a number, a title, an optional one-line status ("Done", "Running 40 %") and a status
 * mark. Arrow keys move between tabs (the WAI-ARIA tabs pattern).
 * tabs: [{ id, n, title, status?: string, tone?: 'done'|'running'|'warn'|'bad'|'pending' }]
 */
export function StepTabs({ tabs, value, onChange, label = 'Steps' }) {
  const refs = useRef({});
  const move = (e, i) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = tabs[(i + d + tabs.length) % tabs.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div className={styles.steps} role="tablist" aria-label={label}>
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-controls={`panel-${t.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={styles.step}
            data-tone={t.tone}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => move(e, i)}
          >
            <span className={styles.num} aria-hidden="true">
              {t.tone === 'done' || t.tone === 'running' || t.tone === 'warn' || t.tone === 'bad' ? <StatusIcon tone={t.tone} size={22} /> : t.n}
            </span>
            <span className={styles.text}>
              <span className={styles.title}>{t.title}</span>
              {t.status && <span className={styles.status}>{t.status}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A small set of choices (Phone / Computer, Live / Picture). options: [{ value, label, icon? }] */
export function Segmented({ options, value, onChange, label, size = 'md' }) {
  return (
    <div className={styles.segmented} data-size={size} role="group" aria-label={label}>
      {options.map(({ value: v, label: l, icon: Icon, title }) => (
        <button key={v} type="button" aria-pressed={v === value} title={title} onClick={() => onChange(v)}>
          {Icon && <Icon size={size === 'sm' ? 13 : 15} aria-hidden="true" />}
          {l && <span>{l}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The dashboard's section tabs: a title with a small status under it and a coloured mark, underlined when selected.
 * Arrow keys, Home and End move between tabs (the WAI-ARIA tabs pattern).
 * tabs: [{ id, title, status?: string, tone?: 'done'|'running'|'warn'|'bad' }]
 */
export function SectionTabs({ tabs, value, onChange, label = 'Sections' }) {
  const refs = useRef({});
  const move = (e, i) => {
    const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = tabs[(keys[e.key] + tabs.length) % tabs.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div className={styles.sections} role="tablist" aria-label={label}>
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-controls={`panel-${t.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={styles.section}
            data-tone={t.tone}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => move(e, i)}
          >
            <span className={styles.sectionTitle}>
              {t.tone && <i className={styles.sectionMark} aria-hidden="true" />}
              {t.title}
            </span>
            {t.status && <span className={styles.sectionStatus}>{t.status}</span>}
          </button>
        );
      })}
    </div>
  );
}
