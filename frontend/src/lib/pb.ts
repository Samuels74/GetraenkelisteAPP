import PocketBase from 'pocketbase';
import type { BookingRecord, GroupRecord, OfferingRecord, PersonRecord, UserRecord } from './types';

/**
 * The single PocketBase SDK client. The SPA is served by PocketBase itself (or
 * by the Vite dev server proxying /api), so the API lives on the same origin.
 * The auth token is kept in the SDK's default localStorage auth store.
 */
export const pb = new PocketBase(window.location.origin);

// Several queries hit the same endpoint concurrently (e.g. different filters);
// the SDK's automatic cancellation of "duplicate" requests would abort them.
pb.autoCancellation(false);

export const usersCollection = () => pb.collection<UserRecord>('users');
export const groupsCollection = () => pb.collection<GroupRecord>('groups');
export const offeringsCollection = () => pb.collection<OfferingRecord>('offerings');
export const personsCollection = () => pb.collection<PersonRecord>('persons');
export const bookingsCollection = () => pb.collection<BookingRecord>('bookings');

/** Relations expanded for booking lists and the CSV export. */
export const BOOKING_EXPAND = 'person,offering.group,createdBy';
