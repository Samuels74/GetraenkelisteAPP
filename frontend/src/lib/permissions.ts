/**
 * UI-side permission checks mirroring the server API rules (ARCHITECTURE.md §4).
 * The server enforces them; these only hide/disable controls.
 */
import type { BookingRecord, UserRecord } from './types';

type Actor = Pick<UserRecord, 'id' | 'role'> | null | undefined;

export function isAdminUser(user: Actor): boolean {
  return user?.role === 'admin';
}

/** bookings.delete: `@request.auth.role = "admin" || createdBy = @request.auth.id` */
export function canCancelBooking(user: Actor, booking: Pick<BookingRecord, 'createdBy'>): boolean {
  return Boolean(user) && (isAdminUser(user) || booking.createdBy === user?.id);
}

/** persons.delete: admin only. */
export function canDeletePersons(user: Actor): boolean {
  return isAdminUser(user);
}

/** users.delete: admin, not the own account. */
export function canDeleteUser(user: Actor, target: Pick<UserRecord, 'id'>): boolean {
  return isAdminUser(user) && user?.id !== target.id;
}
