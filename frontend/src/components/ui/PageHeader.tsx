import type { ReactNode } from 'react';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { cn } from './cn';

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
  className?: string;
}) {
  useDocumentTitle(typeof title === 'string' ? title : null);
  return (
    <header className={cn('flex min-h-16 items-center gap-2 pt-safe', className)}>
      {back}
      <div className="min-w-0 flex-1 py-3">
        <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="truncate text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
