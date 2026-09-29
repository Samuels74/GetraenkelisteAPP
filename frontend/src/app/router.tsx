import { createBrowserRouter, Navigate } from 'react-router';
import { RequireAdmin, RequireAuth } from '../auth/guards';
import { AppShell } from '../components/layout/AppShell';
import { PageSpinner } from '../components/ui/Spinner';
import { BookPage } from '../features/book/BookPage';
import { LoginPage } from '../features/login/LoginPage';
import { NotFoundPage } from './NotFoundPage';
import { RootLayout } from './RootLayout';
import { RouteError } from './RouteError';

/**
 * Routes. Everything except login and the booking screen is code-split.
 *
 *   /login                      Login
 *   /                           Buchen
 *   /personen                   Personen (list)
 *   /personen/:personId         Person detail (QR code)
 *   /personen/qr-codes[?ids=…]  Print sheet with QR codes (no app chrome)
 *   /buchungen                  Buchungen (filters, totals, CSV)
 *   /verwaltung/{angebote,gruppen,benutzer}   Admin
 *   /konto                      Account
 */
export const router = createBrowserRouter([
  {
    Component: RootLayout,
    ErrorBoundary: RouteError,
    HydrateFallback: PageSpinner,
    children: [
      { path: 'login', Component: LoginPage },
      {
        Component: RequireAuth,
        children: [
          {
            path: 'personen/qr-codes',
            lazy: async () => ({ Component: (await import('../features/persons/QrSheetPage')).QrSheetPage }),
          },
          {
            Component: AppShell,
            children: [
              { index: true, Component: BookPage },
              {
                path: 'personen',
                lazy: async () => ({ Component: (await import('../features/persons/PersonsPage')).PersonsPage }),
              },
              {
                path: 'personen/:personId',
                lazy: async () => ({
                  Component: (await import('../features/persons/PersonDetailPage')).PersonDetailPage,
                }),
              },
              {
                path: 'buchungen',
                lazy: async () => ({ Component: (await import('../features/bookings/BookingsPage')).BookingsPage }),
              },
              {
                path: 'konto',
                lazy: async () => ({ Component: (await import('../features/account/AccountPage')).AccountPage }),
              },
              {
                path: 'verwaltung',
                Component: RequireAdmin,
                children: [
                  {
                    lazy: async () => ({ Component: (await import('../features/admin/AdminLayout')).AdminLayout }),
                    children: [
                      { index: true, element: <Navigate to="angebote" replace /> },
                      {
                        path: 'angebote',
                        lazy: async () => ({
                          Component: (await import('../features/admin/OfferingsAdmin')).OfferingsAdmin,
                        }),
                      },
                      {
                        path: 'gruppen',
                        lazy: async () => ({ Component: (await import('../features/admin/GroupsAdmin')).GroupsAdmin }),
                      },
                      {
                        path: 'benutzer',
                        lazy: async () => ({ Component: (await import('../features/admin/UsersAdmin')).UsersAdmin }),
                      },
                    ],
                  },
                ],
              },
              { path: '*', Component: NotFoundPage },
            ],
          },
        ],
      },
    ],
  },
]);
