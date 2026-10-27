'use client';

import { useId, useState } from 'react';
import { AlertCircle, Info, Loader2, Search } from 'lucide-react';
import { ButtonLink } from '@/components/ui';
import { urlCheck } from '@/lib/content';
import { checkSite, type SiteCheckResult } from '@/lib/siteCheck';

type State = { phase: 'empty' } | { phase: 'loading' } | { phase: 'done'; result: SiteCheckResult };

/** The address check: empty, loading, result, error and "not connected" states, all driven by lib/siteCheck.ts. */
export default function UrlCheck() {
  const [value, setValue] = useState('');
  const [state, setState] = useState<State>({ phase: 'empty' });
  const id = useId();
  const busy = state.phase === 'loading';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'done', result: await checkSite(value) });
    } catch {
      setState({ phase: 'done', result: { status: 'error' } });
    }
  }

  const result = state.phase === 'done' ? state.result : null;

  return (
    <div className="ucheck" data-reveal>
      <form className="ucheck__form" onSubmit={submit} noValidate>
        <label htmlFor={id} className="visually-hidden">
          {urlCheck.label}
        </label>
        <span className="ucheck__field" data-invalid={result?.status === 'invalid' || undefined}>
          <Search size={18} aria-hidden="true" />
          <input
            id={id}
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={urlCheck.placeholder}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (state.phase === 'done') setState({ phase: 'empty' });
            }}
            aria-describedby={`${id}-status`}
            aria-invalid={result?.status === 'invalid' || undefined}
          />
        </span>
        <button type="submit" className="btn btn--primary" disabled={busy || !value.trim()}>
          <span className="btn__fx" aria-hidden="true" />
          {busy ? <Loader2 size={17} className="spin" aria-hidden="true" /> : null}
          {urlCheck.button}
        </button>
      </form>

      <div id={`${id}-status`} className="ucheck__status" role="status" aria-live="polite">
        {state.phase === 'empty' && <p className="ucheck__hint">{urlCheck.hint}</p>}
        {busy && <p className="ucheck__hint">{urlCheck.loading}</p>}
        {result?.status === 'invalid' && (
          <p className="ucheck__msg ucheck__msg--bad">
            <AlertCircle size={16} aria-hidden="true" /> {urlCheck.invalid}
          </p>
        )}
        {result?.status === 'error' && (
          <p className="ucheck__msg ucheck__msg--bad">
            <AlertCircle size={16} aria-hidden="true" /> {urlCheck.failed}
          </p>
        )}
        {result?.status === 'not-connected' && (
          <div className="ucheck__card">
            <p className="ucheck__msg">
              <Info size={16} aria-hidden="true" /> <strong>{urlCheck.notConnected.title}</strong>
            </p>
            <p>{urlCheck.notConnected.text}</p>
            <ButtonLink href="/pricing" variant="secondary" size="sm" arrow>
              See the plans
            </ButtonLink>
          </div>
        )}
        {result?.status === 'ok' && (
          <div className="ucheck__card">
            <p className="label">{urlCheck.result.title}</p>
            <ul className="ucheck__stack">
              {result.stack.map((s) => (
                <li key={s.label}>
                  <strong>{s.label}</strong> <span>{s.category}</span>
                </li>
              ))}
            </ul>
            <p>{urlCheck.result.next}</p>
            <ButtonLink href="/pricing" size="sm" arrow>
              {urlCheck.result.cta}
            </ButtonLink>
          </div>
        )}
      </div>
    </div>
  );
}
