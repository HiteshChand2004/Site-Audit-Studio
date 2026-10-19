'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import AuthForm, { type AuthMode } from './AuthForm';
import LogoMark from '@/components/LogoMark';

const TABS: Array<{ mode: AuthMode; label: string }> = [
  { mode: 'signin', label: 'Sign in' },
  { mode: 'signup', label: 'Sign up' },
];

const TITLES: Record<AuthMode, [string, string]> = {
  signin: ['Welcome ', 'back'],
  signup: ['Create your ', 'account'],
};

const LEADS: Record<AuthMode, string> = {
  signin: 'Sign in to audit, rebuild and compare.',
  signup: 'Paste an address. Get a better site.',
};

/* One easing for the whole switch. */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const OUT_MS = 180; // old form fades out
const HEIGHT_MS = 380; // card height tween to the new form

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Sign in / Sign up in one frosted glass card (a fine light travels along its edge).
 *
 * The header switch is two serif words in a tablist with a thin orange underline that glides between them; the
 * title and subline cross-fade. Switching (by the words, arrow keys or the inline links) runs in two phases:
 *   out  the old form fades out with an 8px rise and a light blur (180ms)
 *   in   the new form mounts; its height is measured and the card wrapper tweens once to it (FLIP: height only on
 *        the wrapper, transform/opacity on the content) while the fields stagger in 35ms apart.
 * The width stays fixed, the size observer pauses and the dialog cannot grow a scrollbar mid-switch.
 * Under reduced motion the switch is instant.
 */
export default function AuthCard({
  initialMode = 'signup',
  site,
  focusOnMount = false,
  syncUrl = false,
  idPrefix = 'a',
  titleId,
  close,
}: {
  initialMode?: AuthMode;
  site?: string;
  focusOnMount?: boolean;
  syncUrl?: boolean;
  idPrefix?: string;
  titleId?: string;
  /** A close button (the dialog passes one). */
  close?: ReactNode;
}) {
  const [active, setActive] = useState<AuthMode>(initialMode); // the tab and title (switch at once)
  const [mode, setMode] = useState<AuthMode>(initialMode); // the form on screen (switches after the fade-out)
  const [phase, setPhase] = useState<'enter' | 'out' | 'in'>('enter');
  const card = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const tablist = useRef<HTMLDivElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusFirst = useRef(focusOnMount);
  const switching = useRef(false);
  const timers = useRef<number[]>([]);
  const panelId = useId();

  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Keep the wrapper height in step with the form (errors appearing etc.), except during a switch.
  useEffect(() => {
    const el = inner.current;
    const vp = viewport.current;
    if (!el || !vp) return;
    const ro = new ResizeObserver(() => {
      if (!switching.current) vp.style.height = `${el.offsetHeight}px`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The underline glides to the active word (drawn 100px wide, scaled to the word: transform only).
  const placeLine = useCallback(() => {
    const list = tablist.current;
    const tab = tabs.current[active === 'signin' ? 0 : 1];
    if (!list || !tab) return;
    list.style.setProperty('--lx', `${tab.offsetLeft}px`);
    list.style.setProperty('--ls', String(tab.offsetWidth / 100));
    list.dataset.ready = '';
  }, [active]);
  useIsoLayoutEffect(placeLine, [placeLine]);
  useEffect(() => {
    const list = tablist.current;
    if (!list) return;
    const ro = new ResizeObserver(placeLine); // e.g. when the serif font finishes loading
    ro.observe(list);
    return () => ro.disconnect();
  }, [placeLine]);

  // Phase "in": the new form is in the DOM; tween the wrapper from the locked height to the measured one.
  useIsoLayoutEffect(() => {
    if (phase !== 'in') return;
    const vp = viewport.current;
    const el = inner.current;
    if (!vp || !el) return;
    vp.style.transition = `height ${HEIGHT_MS}ms ${EASE}`;
    void vp.offsetHeight; // commit the locked start height before the new value
    vp.style.height = `${el.offsetHeight}px`;
    later(() => {
      switching.current = false;
      vp.style.transition = '';
      const dlg = card.current?.closest<HTMLElement>('.authdlg');
      dlg?.style.removeProperty('overflow-y');
    }, HEIGHT_MS + 40);
  }, [phase, mode]);

  // Focus the first field on open and after a click/link switch.
  useEffect(() => {
    if (!focusFirst.current) return;
    focusFirst.current = false;
    const t = window.setTimeout(() => inner.current?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true }), phase === 'in' ? 60 : 80);
    return () => window.clearTimeout(t);
  }, [mode, phase]);

  const switchTo = (m: AuthMode, moveFocus: boolean) => {
    if (m === active || switching.current) return;
    setActive(m);
    if (syncUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('mode', m);
      window.history.replaceState(null, '', url);
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      focusFirst.current = moveFocus;
      setMode(m);
      return;
    }
    switching.current = true;
    const vp = viewport.current;
    if (vp) vp.style.height = `${vp.offsetHeight}px`; // lock the current height
    // No scrollbar appearing (and vanishing) mid-switch in the dialog.
    const dlg = card.current?.closest<HTMLElement>('.authdlg');
    if (dlg && dlg.scrollHeight <= dlg.clientHeight) dlg.style.overflowY = 'hidden';
    setPhase('out');
    later(() => {
      focusFirst.current = moveFocus;
      setMode(m);
      setPhase('in');
    }, OUT_MS);
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, AuthMode> = { ArrowLeft: 'signin', ArrowRight: 'signup', Home: 'signin', End: 'signup' };
    const m = keys[e.key];
    if (!m) return;
    e.preventDefault();
    switchTo(m, false);
    tabs.current[m === 'signin' ? 0 : 1]?.focus();
  };

  return (
    <div ref={card} className="authcard aglass" data-mode={active}>
      <span className="aglass__edge" aria-hidden="true">
        <i />
      </span>
      {close}
      <div className="authcard__head">
        <div className="authcard__brand">
          <LogoMark size={36} className="authcard__mark" />
          <div className="authcard__titles">
            <h2 id={titleId} className="display authcard__title">
              {(['signin', 'signup'] as const).map((m) => (
                <span key={m} className="authcard__xf" aria-hidden={m !== active || undefined}>
                  {TITLES[m][0]}
                  <em>{TITLES[m][1]}</em>
                </span>
              ))}
            </h2>
            <p className="authcard__lead">
              {(['signin', 'signup'] as const).map((m) => (
                <span key={m} className="authcard__xf" aria-hidden={m !== active || undefined}>
                  {LEADS[m]}
                </span>
              ))}
            </p>
          </div>
        </div>
        <div ref={tablist} className="tsw" role="tablist" aria-label="Sign in or sign up">
          {TABS.map((t, i) => (
            <span key={t.mode} className="tsw__item">
              {i > 0 && (
                <span className="tsw__dot" aria-hidden="true">
                  ·
                </span>
              )}
              <button
                ref={(n) => {
                  tabs.current[i] = n;
                }}
                type="button"
                role="tab"
                id={`${panelId}-${t.mode}`}
                aria-selected={active === t.mode}
                aria-controls={panelId}
                tabIndex={active === t.mode ? 0 : -1}
                className="tsw__tab"
                onClick={() => switchTo(t.mode, true)}
                onKeyDown={onTabKey}
              >
                {t.label}
              </button>
            </span>
          ))}
          <span className="tsw__line" aria-hidden="true" />
        </div>
      </div>

      <div ref={viewport} className="authcard__viewport">
        <div ref={inner} id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${active}`} className="authcard__inner">
          <div className="auth-swap" data-phase={phase}>
            <AuthForm key={mode} mode={mode} site={site} onSwitch={(m) => switchTo(m, true)} idPrefix={idPrefix} />
          </div>
        </div>
      </div>
    </div>
  );
}
