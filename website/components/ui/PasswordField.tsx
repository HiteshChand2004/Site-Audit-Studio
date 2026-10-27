'use client';

import { useState, type ComponentProps, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { FieldMessage } from './Field';

/** Password input with a show/hide toggle. */
export function PasswordField({ id, label, aside, hint, error, ...rest }: { id: string; label: ReactNode; aside?: ReactNode; hint?: ReactNode; error?: string } & Omit<ComponentProps<'input'>, 'id' | 'type'>) {
  const [shown, setShown] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        <span>{label}</span>
        {aside}
      </label>
      <div className="input-wrap">
        <input {...rest} id={id} type={shown ? 'text' : 'password'} className="input" aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
        <button type="button" className="input-wrap__btn" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} aria-controls={id}>
          {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
      <FieldMessage id={id} hint={hint} error={error} />
    </div>
  );
}
