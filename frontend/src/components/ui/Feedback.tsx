import { RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../../lib/errors';
import { Button } from './Button';
import { cn } from './cn';

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
      {icon ? <div className="rounded-2xl bg-primary-soft p-3 text-on-primary-soft">{icon}</div> : null}
      <p className="text-lg font-semibold">{title}</p>
      {children ? <div className="max-w-sm text-base text-muted">{children}</div> : null}
      {action}
    </div>
  );
}

export function QueryError({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-start gap-3 rounded-2xl bg-danger-soft p-4 text-on-danger-soft', className)}
    >
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
        <span>{errorMessage(error)}</span>
      </p>
      {onRetry ? (
        <Button variant="secondary" icon={<RotateCw className="size-5" aria-hidden />} onClick={onRetry}>
          Erneut versuchen
        </Button>
      ) : null}
    </div>
  );
}

type BadgeTone = 'neutral' | 'primary' | 'danger' | 'success' | 'warning';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-on-primary-soft',
  danger: 'bg-danger-soft text-on-danger-soft',
  success: 'bg-success-soft text-on-success-soft',
  warning: 'bg-warning-soft text-on-warning-soft',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-2xl border border-line bg-surface shadow-sm', className)}>{children}</div>;
}

/** Person number chip, e.g. `001`. */
export function NumberBadge({ number, size = 'md', className }: { number: string; size?: 'md' | 'lg'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-xl bg-primary-soft font-bold tabular-nums text-on-primary-soft',
        size === 'lg' ? 'min-w-16 px-3 py-2 text-2xl' : 'min-w-12 px-2 py-1.5 text-base',
        className,
      )}
    >
      {number}
    </span>
  );
}
