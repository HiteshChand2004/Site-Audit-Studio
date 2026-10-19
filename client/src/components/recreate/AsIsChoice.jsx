import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../../api/client.js';
import { pathOf } from '../project/PageScope.jsx';
import styles from './AsIsChoice.module.css';

/** The stacks an as-is copy can be packaged into (the server's ASIS_STACKS). */
export const ASIS_STACK_CHOICES = [
  { id: 'html', label: 'Plain HTML', note: 'Static files; runs on any host.' },
  { id: 'react-vite', label: 'React + Vite', note: 'Static files in a React project; the copy is not rendered by React.' },
  { id: 'nextjs', label: 'Next.js', note: 'The copy as static files in a Next.js project.' },
  { id: 'mern', label: 'MERN', note: 'Served by an Express server; form submissions can be stored in MongoDB.' },
];

export const AS_IS_EXPLANATION = "Keeps the original site's own code and animations, saved locally. The code is the original's, not new code in the chosen stack.";

/**
 * The mode of a copy: "Clean rebuild" (the default) or "Original as-is". The as-is option is only offered for an authorised
 * project, and needs a confirmation and a choice of pages. Calls onChange with the settings the copy is started with.
 */
export default function AsIsChoice({ projectId, authorized, stack, mode, onMode, pages, onPages, asIsStack, onAsIsStack, confirmed, onConfirmed }) {
  const [available, setAvailable] = useState(null);
  useEffect(() => {
    if (mode !== 'as-is' || available) return;
    let alive = true;
    api.getPages(projectId).then((r) => alive && setAvailable(r.pages ?? [])).catch(() => alive && setAvailable([]));
    return () => { alive = false; };
  }, [mode, projectId, available]);
  const home = available?.[0]?.url ?? null;
  const chosen = new Set(pages);

  return (
    <div className={styles.choice}>
      <fieldset className={styles.modes}>
        <legend>How to make the copy</legend>
        <label className={`${styles.mode} ${mode === 'clean' ? styles.on : ''}`}>
          <input type="radio" name={`mode-${projectId}`} checked={mode === 'clean'} onChange={() => onMode('clean')} />
          <span>
            <strong>Clean rebuild</strong>
            <span className={styles.note}>A new site is built in the chosen stack, with the problems the check found fixed.</span>
          </span>
        </label>
        <label className={`${styles.mode} ${mode === 'as-is' ? styles.on : ''} ${authorized ? '' : styles.disabled}`}>
          <input
            type="radio"
            name={`mode-${projectId}`}
            checked={mode === 'as-is'}
            disabled={!authorized}
            onChange={() => onMode('as-is')}
          />
          <span>
            <strong>Original as-is</strong>
            <span className={styles.note}>{AS_IS_EXPLANATION}</span>
            {!authorized && <span className={styles.note}>Only for a project marked as authorised (your own or a client's site).</span>}
          </span>
        </label>
      </fieldset>

      {mode === 'as-is' && authorized && (
        <div className={styles.asis}>
          <div className={styles.pages}>
            <div className={styles.label}>Pages to copy</div>
            {available === null && <div className={styles.note}>Loading the pages…</div>}
            {available?.length === 0 && <div className={styles.note}>No page is known yet: check the site first (step 1).</div>}
            <ul>
              {(available ?? []).slice(0, 40).map((p) => {
                const isHome = p.url === home;
                const on = isHome || chosen.has(p.url);
                return (
                  <li key={p.url}>
                    <label>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={isHome}
                        onChange={(e) => onPages(e.target.checked ? [...pages, p.url] : pages.filter((u) => u !== p.url))}
                      />
                      <span className="mono">{pathOf(p.url) || '/'}</span>
                      {isHome && <span className={styles.note}> homepage</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className={styles.note}>Links between the pages you choose point at their copies; other links stay links to the original.</div>
          </div>

          <div className={styles.stack}>
            <div className={styles.label}>Package it as</div>
            <div className={styles.stacks}>
              {ASIS_STACK_CHOICES.map((s) => (
                <button key={s.id} type="button" className={`${styles.stackBtn} ${asIsStack === s.id ? styles.on : ''}`} onClick={() => onAsIsStack(s.id)}>
                  {asIsStack === s.id && <Check size={14} aria-hidden />} {s.label}
                  <span className={styles.note}>{s.note}</span>
                </button>
              ))}
            </div>
            <div className={styles.note}>Project stack: {stack}.</div>
          </div>

          <label className={styles.confirm}>
            <input type="checkbox" checked={confirmed} onChange={(e) => onConfirmed(e.target.checked)} />
            <span>I am allowed to copy this site as it is (it is my own site, or a client's who has asked me to).</span>
          </label>
        </div>
      )}
    </div>
  );
}
