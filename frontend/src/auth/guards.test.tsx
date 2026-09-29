import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, useLocation } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { pb } from '../lib/pb';
import type { UserRecord } from '../lib/types';
import { RequireAuth } from './guards';
import type * as SessionModule from './session';

const remembered = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  getRememberedLoginPassword: () => remembered.value,
}));

const baseUser: UserRecord = {
  id: 'u1',
  collectionId: '_pb_users_auth_',
  collectionName: 'users',
  created: '',
  updated: '',
  username: 'anna',
  name: 'Anna',
  role: 'user',
  mustChangePassword: false,
  disabled: false,
};

function LoginProbe() {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  return <p>Login – from: {from ?? '-'}</p>;
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginProbe /> },
      {
        element: <RequireAuth />,
        children: [{ path: '/buchungen', element: <p>Buchungen-Seite</p> }],
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  act(() => pb.authStore.clear());
  remembered.value = null;
});

describe('RequireAuth', () => {
  it('sends logged-out users to /login and remembers the requested page', () => {
    renderAt('/buchungen?zeitraum=heute');
    expect(screen.getByText('Login – from: /buchungen?zeitraum=heute')).toBeInTheDocument();
  });

  it('renders the page for a normal session', () => {
    pb.authStore.save('token', baseUser);
    renderAt('/buchungen');
    expect(screen.getByText('Buchungen-Seite')).toBeInTheDocument();
  });

  it('blocks every route with the password screen while mustChangePassword is set', () => {
    remembered.value = 'admin';
    pb.authStore.save('token', { ...baseUser, mustChangePassword: true });
    renderAt('/buchungen');
    expect(screen.getByRole('heading', { name: 'Neues Passwort festlegen' })).toBeInTheDocument();
    expect(screen.queryByText('Buchungen-Seite')).not.toBeInTheDocument();
    // the login password is reused → no "current password" field
    expect(screen.queryByLabelText('Aktuelles Passwort')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Neues Passwort')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abmelden' })).toBeInTheDocument();
  });

  it('asks for the current password when the login password is not known (reload)', () => {
    pb.authStore.save('token', { ...baseUser, mustChangePassword: true });
    renderAt('/buchungen');
    expect(screen.getByLabelText('Aktuelles Passwort')).toBeInTheDocument();
  });

  it('continues to the requested page once the password was changed', () => {
    pb.authStore.save('token', { ...baseUser, mustChangePassword: true });
    renderAt('/buchungen');
    expect(screen.queryByText('Buchungen-Seite')).not.toBeInTheDocument();
    act(() => pb.authStore.save('token2', { ...baseUser, mustChangePassword: false }));
    expect(screen.getByText('Buchungen-Seite')).toBeInTheDocument();
  });

  it('does not remember the page after an explicit logout', async () => {
    pb.authStore.save('token', { ...baseUser, mustChangePassword: true });
    renderAt('/buchungen');
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    expect(await screen.findByText('Login – from: -')).toBeInTheDocument();
  });
});
