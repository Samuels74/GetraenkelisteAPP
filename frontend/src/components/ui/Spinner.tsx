import { cn } from './cn';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      className={cn('size-6 animate-spin text-current', className)}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PageSpinner() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-primary">
      <Spinner className="size-8" label="Wird geladen …" />
    </div>
  );
}
