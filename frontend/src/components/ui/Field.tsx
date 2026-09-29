import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from './cn';

const controlClass =
  'block w-full min-h-12 rounded-xl border border-line-strong bg-surface px-3.5 text-base text-fg ' +
  'placeholder:text-muted/80 shadow-sm transition-colors ' +
  'focus:border-primary focus:outline-2 focus:outline-offset-0 focus:outline-primary/40 ' +
  'disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:outline-danger/40';

interface FieldShellProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
  hideLabel?: boolean;
}

function FieldShell({ id, label, hint, error, className, children, hideLabel }: FieldShellProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className={cn('text-sm font-medium text-fg', hideLabel && 'sr-only')}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  containerClassName?: string;
  hideLabel?: boolean;
  /** Focus this field when a surrounding dialog opens. */
  dialogAutoFocus?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  containerClassName,
  className,
  hideLabel,
  dialogAutoFocus,
  ...rest
}: TextFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={containerClassName} hideLabel={hideLabel}>
      <input
        id={id}
        className={cn(controlClass, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        data-autofocus={dialogAutoFocus ? '' : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  containerClassName?: string;
  hideLabel?: boolean;
}

export function SelectField({
  label,
  hint,
  error,
  containerClassName,
  className,
  hideLabel,
  children,
  ...rest
}: SelectFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={containerClassName} hideLabel={hideLabel}>
      <select
        id={id}
        className={cn(controlClass, 'appearance-none bg-no-repeat pr-10', className)}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
          backgroundPosition: 'right 0.75rem center',
          backgroundSize: '1.25rem',
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
}

interface SwitchFieldProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  name?: string;
}

/** A full-width toggle row (≥ 48 px) using a native checkbox with switch role. */
export function SwitchField({ label, description, checked, onChange, disabled, className, name }: SwitchFieldProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-h-12 items-center justify-between gap-4 rounded-xl py-1.5',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        className,
      )}
    >
      <span className="flex flex-col">
        <span className="text-base font-medium text-fg">{label}</span>
        {description ? <span className="text-sm text-muted">{description}</span> : null}
      </span>
      <span className="relative inline-flex shrink-0 items-center">
        <input
          id={id}
          name={name}
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden
          className={cn(
            'h-8 w-14 rounded-full border border-line-strong bg-surface-3 transition-colors',
            'peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:outline-2',
            'peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
          )}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-1 size-6 rounded-full bg-white shadow transition-transform peer-checked:translate-x-6"
        />
      </span>
    </label>
  );
}

/** Form-level error (server messages that are not tied to a field). */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-on-danger-soft">
      {message}
    </div>
  );
}
