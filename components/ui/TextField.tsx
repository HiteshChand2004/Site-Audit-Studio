'use client';

import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Check, Eye, EyeOff } from 'lucide-react';

type Props = {
  id: string;
  label: string;
  required?: boolean;
  /** Shown at the right end of the label row (e.g. "Forgot password?"). */
  aside?: ReactNode;
  /** Short friendly error under the field (red border + one gentle shake when it appears). */
  error?: string;
  /** Show the green tick (the field just became valid). */
  valid?: boolean;
  /** Bumped each time the error should shake again. */
  shake?: number;
  /** Extra ids for aria-describedby (e.g. a strength meter). */
  describedBy?: string;
} & Omit<ComponentProps<'input'>, 'id' | 'children'>;

/**
 * Input with its label above (red asterisk on required ones) and the example placeholder inside, visible whenever
 * the field is empty. On focus a thin accent line draws across the input and a soft glow comes up. Password fields
 * get a show/hide toggle.
 */
export function TextField({ id, label, required, aside, error, valid, shake = 0, describedBy, type = 'text', className = '', ...rest }: Props) {
  const [shown, setShown] = useState(false);
  const [shaking, setShaking] = useState(false);

  // One gentle shake each time the error is (re)shown; cleared when the animation ends.
  useEffect(() => {
    if (shake) setShaking(true);
  }, [shake]);

  const isPassword = type === 'password';
  const errId = `${id}-error`;
  const ids = [error ? errId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`tf ${className}`} data-invalid={error ? '' : undefined} data-valid={valid && !error ? '' : undefined} data-password={isPassword || undefined}>
      <div className="tf__top">
        <label className="tf__label" htmlFor={id}>
          {label}
          {required && (
            <span className="tf__req" aria-hidden="true">
              *
            </span>
          )}
        </label>
        {aside}
      </div>
      <div className="tf__box" data-shake={shaking && error ? '' : undefined} onAnimationEnd={() => setShaking(false)}>
        <input
          {...rest}
          id={id}
          type={isPassword && shown ? 'text' : type}
          className="tf__input"
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={ids}
        />
        <span className="tf__ok" aria-hidden="true">
          <Check size={13} strokeWidth={3} />
        </span>
        {isPassword && (
          <button type="button" className="tf__eye" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} aria-controls={id}>
            {shown ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        )}
      </div>
      <p id={errId} className="tf__msg" aria-live="polite">
        {error}
      </p>
    </div>
  );
}
