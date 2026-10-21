import { Beer, CircleUserRound, ReceiptText, Settings, Users, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link, NavLink, Outlet, useNavigation } from 'react-router';
import { useSonner } from 'sonner';
import { isAdmin, useCurrentUser } from '../../auth/session';
import type { UserRecord } from '../../lib/types';
import { useOnline } from '../../lib/useOnline';
import { AppLogo } from '../AppLogo';
import { cn } from '../ui/cn';
import { OFFLINE_BANNER_HEIGHT, TopBar } from './TopBar';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  testId: string;
  end?: boolean;
  adminOnly?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Buchen', icon: Beer, testId: 'nav-buchen', end: true },
  { to: '/personen', label: 'Personen', icon: Users, testId: 'nav-personen' },
  { to: '/buchungen', label: 'Buchungen', icon: ReceiptText, testId: 'nav-buchungen' },
  { to: '/verwaltung', label: 'Verwaltung', icon: Settings, testId: 'nav-verwaltung', adminOnly: true },
  { to: '/konto', label: 'Konto', icon: CircleUserRound, testId: 'nav-konto' },
];

/**
 * One navigation element: a bottom tab bar on phones/tablets and a side bar
 * on large screens (CSS only, so test ids / roles are unique).
 */
export function MainNav({ user }: { user: UserRecord }) {
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin(user));
  return (
    <nav
      aria-label="Hauptnavigation"
      data-testid="main-nav"
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur-md print:hidden',
        'lg:inset-y-0 lg:right-auto lg:flex lg:w-64 lg:flex-col lg:border-t-0 lg:border-r lg:bg-surface lg:pb-0',
      )}
    >
      <Link
        to="/"
        className="hidden items-center gap-3 px-6 pt-6 pb-8 text-lg font-bold tracking-tight lg:flex"
        aria-label="Getränkeliste – Startseite"
      >
        <AppLogo className="size-10" />
        Getränkeliste
      </Link>
      <ul className="mx-auto flex max-w-xl lg:mx-0 lg:max-w-none lg:flex-col lg:gap-1 lg:px-3">
        {items.map(({ to, label, icon: Icon, testId, end }) => (
          <li key={to} className="min-w-0 flex-1 lg:flex-none">
            <NavLink
              to={to}
              end={end}
              data-testid={testId}
              className={({ isActive }) =>
                cn(
                  'flex h-16 flex-col items-center justify-center gap-0.5 text-xs font-semibold transition-colors',
                  'lg:h-12 lg:flex-row lg:justify-start lg:gap-3 lg:rounded-xl lg:px-3 lg:text-base',
                  isActive
                    ? 'text-primary lg:bg-primary-soft lg:text-on-primary-soft'
                    : 'text-muted hover:text-fg lg:hover:bg-surface-2',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      // (max-w-full: five tabs on a 320 px phone with large text)
                      'flex h-8 w-14 max-w-full items-center justify-center rounded-full transition-colors lg:h-auto lg:w-auto',
                      isActive && 'bg-primary-soft text-on-primary-soft lg:bg-transparent',
                    )}
                  >
                    <Icon className="size-6" aria-hidden strokeWidth={isActive ? 2.4 : 2} />
                  </span>
                  <span className="max-w-full truncate px-0.5">{label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="mt-auto hidden border-t border-line px-6 py-4 text-sm text-muted lg:block">
        Angemeldet als <span className="font-semibold text-fg">{user.name || user.username}</span>
      </div>
    </nav>
  );
}

function RouteProgress() {
  const navigation = useNavigation();
  if (navigation.state !== 'loading') return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden bg-primary-soft" role="progressbar" aria-label="Seite wird geladen">
      <div className="h-full w-1/3 animate-pulse bg-primary" />
    </div>
  );
}

/**
 * Layout for all logged-in pages. It owns the top safe-area inset once
 * (pt-app on the page, TopBar above sticky bars) and, while the browser is
 * offline, the "Keine Verbindung" banner (--offline-banner moves the page and
 * its sticky bars below it).
 */
export function AppShell() {
  const user = useCurrentUser();
  const online = useOnline();
  // While a toast is shown, extra space at the end lets the last rows of a
  // page scroll above it (e.g. the cancel buttons of "Letzte Buchungen").
  const toastVisible = useSonner().toasts.length > 0;
  if (!user) return null;
  const style = { '--offline-banner': online ? '0px' : OFFLINE_BANNER_HEIGHT } as CSSProperties;
  return (
    <div className="min-h-dvh" style={style}>
      <RouteProgress />
      <TopBar offline={!online} />
      <MainNav user={user} />
      <div className="lg:pl-64">
        <main
          className={cn(
            'mx-auto w-full max-w-4xl px-safe pt-app lg:px-8',
            toastVisible ? 'pb-nav-toast' : 'pb-nav lg:pb-12',
          )}
          data-testid="page-content"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
