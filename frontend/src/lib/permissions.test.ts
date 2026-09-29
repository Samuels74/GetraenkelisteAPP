import { canCancelBooking, canDeletePersons, canDeleteUser, isAdminUser } from './permissions';

const admin = { id: 'a', role: 'admin' as const };
const user = { id: 'u', role: 'user' as const };

describe('permissions', () => {
  it('lets users cancel only their own bookings, admins all', () => {
    expect(canCancelBooking(user, { createdBy: 'u' })).toBe(true);
    expect(canCancelBooking(user, { createdBy: 'x' })).toBe(false);
    expect(canCancelBooking(admin, { createdBy: 'x' })).toBe(true);
    expect(canCancelBooking(null, { createdBy: 'u' })).toBe(false);
  });

  it('restricts person deletion to admins', () => {
    expect(canDeletePersons(admin)).toBe(true);
    expect(canDeletePersons(user)).toBe(false);
  });

  it('prevents admins from deleting themselves', () => {
    expect(canDeleteUser(admin, { id: 'u' })).toBe(true);
    expect(canDeleteUser(admin, { id: 'a' })).toBe(false);
    expect(canDeleteUser(user, { id: 'x' })).toBe(false);
    expect(isAdminUser(undefined)).toBe(false);
  });
});
