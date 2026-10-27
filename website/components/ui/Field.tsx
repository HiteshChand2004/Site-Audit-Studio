import type { ComponentProps, ReactNode } from 'react';

type FieldProps = {
  id: string;
  label: ReactNode;
  /** Shown next to the label, e.g. a "Forgot password?" link. */
  aside?: ReactNode;
  hint?: ReactNode;
  error?: string;
  as?: 'input' | 'textarea' | 'select';
  children?: ReactNode;
} & Omit<ComponentProps<'input'>, 'id' | 'children'> &
  Omit<ComponentProps<'textarea'>, 'id' | 'children'>;

/** Label + input/textarea/select + hint or error, wired with aria-describedby and aria-invalid. */
export function Field({ id, label, aside, hint, error, as = 'input', children, ...rest }: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const common = { id, className: 'input', 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy };
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        <span>{label}</span>
        {aside}
      </label>
      {as === 'textarea' ? (
        <textarea {...(rest as ComponentProps<'textarea'>)} {...common} />
      ) : as === 'select' ? (
        <select {...(rest as unknown as ComponentProps<'select'>)} {...common}>
          {children}
        </select>
      ) : (
        <input {...(rest as ComponentProps<'input'>)} {...common} />
      )}
      <FieldMessage id={id} hint={hint} error={error} />
    </div>
  );
}

export function FieldMessage({ id, hint, error }: { id: string; hint?: ReactNode; error?: string }) {
  if (error)
    return (
      <p id={`${id}-error`} className="field__error" role="alert">
        {error}
      </p>
    );
  if (hint)
    return (
      <p id={`${id}-hint`} className="field__hint">
        {hint}
      </p>
    );
  return null;
}
