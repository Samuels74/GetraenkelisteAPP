/**
 * Record shapes of the PocketBase collections (ARCHITECTURE.md §4).
 * Timestamps use PocketBase's `YYYY-MM-DD HH:MM:SS.sssZ` format.
 */

export interface BaseRecord {
  id: string;
  collectionId: string;
  collectionName: string;
  created: string;
  updated: string;
}

export type Role = 'admin' | 'user';

export interface UserRecord extends BaseRecord {
  username: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
}

export interface GroupRecord extends BaseRecord {
  name: string;
  sortOrder: number;
}

export interface OfferingRecord extends BaseRecord {
  name: string;
  group: string;
  priceCents: number;
  active: boolean;
  sortOrder: number;
}

export interface PersonRecord extends BaseRecord {
  number: string;
  name: string;
  nickname: string;
}

export interface BookingRecord extends BaseRecord {
  person: string;
  offering: string;
  quantity: number;
  unitPriceCents: number;
  createdBy: string;
  expand?: {
    person?: PersonRecord;
    offering?: OfferingRecord & { expand?: { group?: GroupRecord } };
    createdBy?: UserRecord;
  };
}

export interface TotalsPerPerson {
  personId: string;
  number: string;
  name: string;
  nickname: string;
  count: number;
  quantity: number;
  totalCents: number;
}

export interface TotalsPerOffering {
  offeringId: string;
  name: string;
  groupId: string;
  groupName: string;
  count: number;
  quantity: number;
  totalCents: number;
}

export interface TotalsPerUser {
  userId: string;
  username: string;
  name: string;
  count: number;
  quantity: number;
  totalCents: number;
}

/** The parts of `GET /api/app/totals` a screen can ask for (`parts=`, ARCHITECTURE.md §5). */
export type TotalsPart = 'summary' | 'perPerson' | 'perOffering' | 'perUser';

/** The `summary` part: the top-level count and sums. */
export interface TotalsSummary {
  count: number;
  quantity: number;
  totalCents: number;
}

/**
 * Response of `GET /api/app/totals` (ARCHITECTURE.md §5). Only the requested
 * parts are present – a missing key means "not requested / not loaded yet",
 * never "no bookings" (that is an empty array or a count of 0).
 */
export interface Totals extends Partial<TotalsSummary> {
  perPerson?: TotalsPerPerson[];
  perOffering?: TotalsPerOffering[];
  perUser?: TotalsPerUser[];
}
