'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import AuthCard from './AuthCard';
import AuthStage from './AuthStage';
import type { AuthMode } from './AuthForm';

const DESKTOP = '(min-width: 640px)';
const CLOSE_MS = 240;

/**
 * The auth modal. On desktop, any click on a link to /auth (e.g. "Get started") opens this dialog instead of
 * navigating; on phones, and with modifier keys, the link goes to the full /auth page as usual.
 * A native modal <dialog> fills the viewport with the cinematic stage, makes the rest of the page inert (focus
 * trap) and closes on Escape or a click outside the card.
 */
export default function AuthDialog() {
  const pathname = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<{ mode: AuthMode; site?: string; key: number } | null>(null);

  const close = useCallback(() => {
    const d = dialog.current;
    if (!d?.open) return;
    d.dataset.closing = '';
    window.setTimeout(() => {
      d.close();
      delete d.dataset.closing;
      document.documentElement.style.removeProperty('overflow');
      setState(null);
      opener.current?.focus({ preventScroll: true });
    }, CLOSE_MS);
  }, []);

  // Intercept clicks on /auth links (desktop only, never on the /auth page itself).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a');
      if (!a || a.target === '_blank') return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== '/auth') return;
      if (window.location.pathname === '/auth' || !window.matchMedia(DESKTOP).matches) return;
      e.preventDefault();
      opener.current = a;
      setState((s) => ({ mode: url.searchParams.get('mode') === 'signin' ? 'signin' : 'signup', site: url.searchParams.get('site') ?? undefined, key: (s?.key ?? 0) + 1 }));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Also open from forms that GET /auth (the "Paste your address" form on the home page).
  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement;
      if (!(form instanceof HTMLFormElement) || form.method !== 'get') return;
      const url = new URL(form.action, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== '/auth' || !window.matchMedia(DESKTOP).matches) return;
      e.preventDefault();
      const data = new FormData(form);
      opener.current = (e.submitter as HTMLElement) ?? form;
      setState((s) => ({ mode: data.get('mode') === 'signin' ? 'signin' : 'signup', site: String(data.get('site') ?? '') || undefined, key: (s?.key ?? 0) + 1 }));
    };
    document.addEventListener('submit', onSubmit);
    return () => document.removeEventListener('submit', onSubmit);
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!state || !d || d.open) return;
    d.showModal();
    document.documentElement.style.overflow = 'hidden';
  }, [state]);

  // Navigating away closes the dialog.
  useEffect(() => {
    close();
  }, [pathname, close]);

  return (
    <dialog
      ref={dialog}
      className="authdlg"
      aria-labelledby="authdlg-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (!(e.target as Element).closest('.aglass')) close(); // a click on the stage, outside the card
      }}
    >
      {state && (
        <AuthStage className="astage--dialog">
          <AuthCard
            key={state.key}
            initialMode={state.mode}
            site={state.site}
            focusOnMount
            idPrefix="m"
            titleId="authdlg-title"
            close={
              <button type="button" className="authdlg__close" onClick={close} aria-label="Close">
                <X size={18} aria-hidden="true" />
              </button>
            }
          />
        </AuthStage>
      )}
    </dialog>
  );
}
