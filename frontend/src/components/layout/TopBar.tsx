import { WifiOff } from 'lucide-react';

/** Height of the offline banner; AppShell sets it as --offline-banner while offline. */
export const OFFLINE_BANNER_HEIGHT = '2.25rem';

/**
 * Fixed top of the logged-in screens. It covers the status bar area
 * (safe-area inset, edge-to-edge displays) behind the sticky bars, and below
 * it shows "Keine Verbindung" while the browser is offline – one line, never
 * blocking a tap. The page container (pt-app) and the sticky bars (top-app)
 * start below both, so nothing is hidden under it.
 */
export function TopBar({ offline }: { offline: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-30 bg-canvas/90 pt-safe backdrop-blur-md lg:left-64 print:hidden">
      <div role="status">
        {offline ? (
          <p
            className="flex h-9 items-center justify-center gap-2 bg-fg px-4 text-sm font-semibold text-canvas"
            data-testid="offline-banner"
          >
            <WifiOff className="size-4 shrink-0" aria-hidden />
            Keine Verbindung
          </p>
        ) : null}
      </div>
    </div>
  );
}
