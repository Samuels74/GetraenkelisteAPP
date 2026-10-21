import { CloudOff, RotateCw } from 'lucide-react';
import { useConnectionHint } from '../api/connection';
import { Button } from './ui/Button';
import { cn } from './ui/cn';

/**
 * Inline hint next to content that may be outdated: a background refresh
 * failed (server unreachable, a proxy's error page) and the screen kept what
 * it showed, or realtime has been down for a while (api/connection.ts).
 * Non-blocking – the content stays usable – with a retry. Offline the banner
 * at the top says it instead.
 */
export function ConnectionHint({ className }: { className?: string }) {
  const { shown, retry, retrying } = useConnectionHint();
  if (!shown) return null;
  return (
    <div
      role="status"
      data-testid="connection-hint"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-warning-soft py-1 pr-1 pl-4 text-on-warning-soft',
        className,
      )}
    >
      <p className="flex min-w-0 flex-[1_1_12rem] items-start gap-2 py-2 text-sm font-medium">
        <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>Verbindung zum Server unterbrochen – Anzeige evtl. nicht aktuell.</span>
      </p>
      <Button
        variant="ghost"
        icon={<RotateCw className="size-5" aria-hidden />}
        loading={retrying}
        onClick={retry}
        className="text-sm text-on-warning-soft hover:bg-black/5 dark:hover:bg-white/10"
      >
        Erneut versuchen
      </Button>
    </div>
  );
}
