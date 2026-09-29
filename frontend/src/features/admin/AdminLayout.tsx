import { NavLink, Outlet } from 'react-router';
import { cn } from '../../components/ui/cn';
import { PageHeader } from '../../components/ui/PageHeader';

const TABS = [
  { to: '/verwaltung/angebote', label: 'Angebote', testId: 'admin-tab-angebote' },
  { to: '/verwaltung/gruppen', label: 'Gruppen', testId: 'admin-tab-gruppen' },
  { to: '/verwaltung/benutzer', label: 'Benutzer', testId: 'admin-tab-benutzer' },
];

export function AdminLayout() {
  return (
    <>
      <PageHeader title="Verwaltung" />
      <nav aria-label="Verwaltung" className="mb-4">
        <ul className="flex gap-1 rounded-2xl bg-surface-2 p-1">
          {TABS.map((tab) => (
            <li key={tab.to} className="flex-1">
              <NavLink
                to={tab.to}
                data-testid={tab.testId}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-12 items-center justify-center rounded-xl px-2 text-sm font-semibold transition-colors',
                    isActive ? 'bg-surface text-fg shadow-sm dark:bg-surface-3' : 'text-muted hover:text-fg',
                  )
                }
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </>
  );
}
