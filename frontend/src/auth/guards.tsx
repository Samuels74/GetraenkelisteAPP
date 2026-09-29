import { Navigate, Outlet, useLocation } from 'react-router';
import { ForcePasswordChange } from '../features/account/ForcePasswordChange';
import { isAdmin, useCurrentUser, wasLoggedOutExplicitly } from './session';

/**
 * Only for logged-in users. Otherwise → /login; the requested page is
 * remembered (and opened after login) unless the user logged out explicitly.
 * Users with `mustChangePassword` see the blocking password screen on every
 * route until they set their own password; then the requested page renders.
 */
export function RequireAuth() {
  const user = useCurrentUser();
  const location = useLocation();
  if (!user) {
    const from = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to="/login" replace state={wasLoggedOutExplicitly() ? null : { from }} />;
  }
  if (user.mustChangePassword) return <ForcePasswordChange user={user} />;
  return <Outlet />;
}

/** Admin-only area (mirrors the server rules; the server enforces them). */
export function RequireAdmin() {
  const user = useCurrentUser();
  if (!isAdmin(user)) return <Navigate to="/" replace />;
  return <Outlet />;
}
