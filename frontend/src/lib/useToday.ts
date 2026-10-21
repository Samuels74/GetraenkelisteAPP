/**
 * "Now" for lists that label days ("Heute", "Gestern", time only for today's
 * bookings). A value frozen at mount kept yesterday's labels after midnight
 * while the screen stayed open – a bar closes after midnight. The Date
 * changes at local midnight and when the page becomes visible again (timers
 * of hidden pages may be delayed or frozen); within a day it stays the same
 * object, so memoized lists recompute only when the day changes.
 *
 * It uses the one midnight timer of the app (api/midnight.ts), which also
 * moves the "Heute" / 7 / 30 Tage data on – headings and data change together.
 */
import { useSyncExternalStore } from 'react';
import { getDay, subscribeToDay } from '../api/midnight';

export function useToday(): Date {
  return useSyncExternalStore(subscribeToDay, getDay, getDay);
}
