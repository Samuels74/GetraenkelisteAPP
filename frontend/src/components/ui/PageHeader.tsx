import type { ReactNode } from 'react';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { cn } from './cn';

/**
 * Page title row. The actions move below the title when both do not fit
 * (narrow phones with large text) instead of squeezing the title to "B…".
 * No safe-area padding here: the AppShell owns the top inset (pt-app).
 */
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
    <header className={cn('flex min-h-16 flex-wrap items-center gap-x-2', className)}>
      <div className="flex min-w-0 flex-[1_1_10rem] items-center gap-2">
        {back}
        <div className="min-w-0 flex-1 py-3">
          <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle ? <p className="truncate text-sm text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </header>
  );
}
