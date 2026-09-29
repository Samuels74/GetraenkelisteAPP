/**
 * Test data through the PocketBase REST API (SDK).
 *
 * Every test gets its own `TestData` with a random token. All records it
 * creates carry that token (usernames, person numbers/names, group and
 * offering names), which makes tests independent of each other when they run
 * in parallel against the same PocketBase and lets `cleanup()` remove
 * everything the test created – also records created through the UI, as long
 * as their names contain the token (use `data.id()` / `data.name()`).
 */
import { randomInt } from 'node:crypto';
import PocketBase, { type RecordModel } from 'pocketbase';
import { BASE_URL } from './env';

export type Role = 'admin' | 'user';

export interface UserRecord extends RecordModel {
  username: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
}

export interface GroupRecord extends RecordModel {
  name: string;
  sortOrder: number;
}

export interface OfferingRecord extends RecordModel {
  name: string;
  group: string;
  priceCents: number;
  active: boolean;
  sortOrder: number;
}

export interface PersonRecord extends RecordModel {
  number: string;
  name: string;
  nickname: string;
}

export interface BookingRecord extends RecordModel {
  person: string;
  offering: string;
  quantity: number;
  unitPriceCents: number;
  createdBy: string;
  created: string;
}

export interface TestUser {
  id: string;
  username: string;
  /** Current password. */
  password: string;
  name: string;
  role: Role;
  /** API client logged in as this user. */
  api: PocketBase;
}

export function apiClient(): PocketBase {
  const pb = new PocketBase(BASE_URL);
  pb.autoCancellation(false);
  return pb;
}

export async function apiLogin(username: string, password: string): Promise<PocketBase> {
  const pb = apiClient();
  await pb.collection('users').authWithPassword(username, password);
  return pb;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random lowercase token, e.g. `k3x9ab` (valid in usernames and person numbers). */
export function randomToken(length = 6): string {
  let token = ALPHABET[randomInt(26)]!; // starts with a letter
  while (token.length < length) token += ALPHABET[randomInt(ALPHABET.length)];
  return token;
}

export class TestData {
  readonly token = randomToken();
  private counter = 0;

  constructor(readonly admin: PocketBase) {}

  /** Unique identifier (username, person number): `<prefix><token><n>`. */
  id(prefix = ''): string {
    return `${prefix}${this.token}${++this.counter}`;
  }

  /** Unique display name: `<label> <token><n>`. */
  name(label: string): string {
    return `${label} ${this.token}${++this.counter}`;
  }

  /**
   * Creates a user through the bootstrap admin. Users created by an admin must
   * change their password (blocking screen after login); unless that is what the
   * test is about (`mustChangePassword: true`), the admin clears the flag.
   */
  async user(
    options: { role?: Role; name?: string; username?: string; password?: string; mustChangePassword?: boolean } = {},
  ): Promise<TestUser> {
    const username = options.username ?? this.id('u');
    const role = options.role ?? 'user';
    const name = options.name ?? '';
    const password = options.password ?? `pw-${this.id()}`;
    const record = await this.admin
      .collection('users')
      .create<UserRecord>({ username, password, passwordConfirm: password, role, name });
    if (!options.mustChangePassword) {
      await this.admin.collection('users').update(record.id, { mustChangePassword: false });
    }
    const api = await apiLogin(username, password);
    return { id: record.id, username, password, name, role, api };
  }

  async disableUser(user: Pick<TestUser, 'id'>): Promise<void> {
    await this.admin.collection('users').update(user.id, { disabled: true });
  }

  /**
   * Groups get a distinct sortOrder that grows with the creation time: moving a
   * group in the administration then only swaps two records (with duplicates
   * the app renumbers every group), and groups of tests that start later are
   * appended below – they do not push this test's tiles down while it taps them.
   */
  group(options: { name?: string; sortOrder?: number } = {}): Promise<GroupRecord> {
    return this.admin.collection('groups').create<GroupRecord>({
      name: options.name ?? this.name('Gruppe'),
      sortOrder: options.sortOrder ?? Date.now() * 1_000 + randomInt(1_000),
    });
  }

  offering(
    group: Pick<GroupRecord, 'id'>,
    options: { name?: string; priceCents?: number; active?: boolean; sortOrder?: number } = {},
  ): Promise<OfferingRecord> {
    return this.admin.collection('offerings').create<OfferingRecord>({
      name: options.name ?? this.name('Angebot'),
      group: group.id,
      priceCents: options.priceCents ?? 0,
      active: options.active ?? true,
      sortOrder: options.sortOrder ?? ++this.counter * 10,
    });
  }

  /** A group with one active offering per entry of `offerings`. */
  async catalog(
    offerings: Array<{ label: string; priceCents: number }>,
    groupOptions: { name?: string; sortOrder?: number } = {},
  ): Promise<{ group: GroupRecord; offerings: OfferingRecord[] }> {
    const group = await this.group(groupOptions);
    const created: OfferingRecord[] = [];
    for (const [index, entry] of offerings.entries()) {
      created.push(
        await this.offering(group, { name: this.name(entry.label), priceCents: entry.priceCents, sortOrder: (index + 1) * 10 }),
      );
    }
    return { group, offerings: created };
  }

  person(options: { number?: string; name?: string; nickname?: string } = {}): Promise<PersonRecord> {
    return this.admin.collection('persons').create<PersonRecord>({
      number: options.number ?? this.id('p'),
      name: options.name ?? this.name('Gast'),
      nickname: options.nickname ?? '',
    });
  }

  /** Books `offering` for `person` (as `by`, default: the bootstrap admin). */
  booking(
    person: Pick<PersonRecord, 'id'>,
    offering: Pick<OfferingRecord, 'id'>,
    options: { by?: TestUser; quantity?: number } = {},
  ): Promise<BookingRecord> {
    const api = options.by?.api ?? this.admin;
    return api
      .collection('bookings')
      .create<BookingRecord>({ person: person.id, offering: offering.id, quantity: options.quantity ?? 1 });
  }

  /** All bookings of a person (newest first). */
  bookingsOf(person: Pick<PersonRecord, 'id'>): Promise<BookingRecord[]> {
    return this.admin
      .collection('bookings')
      .getFullList<BookingRecord>({ filter: this.admin.filter('person = {:id}', { id: person.id }), sort: '-created,-id' });
  }

  async findPerson(number: string): Promise<PersonRecord | null> {
    const items = await this.admin
      .collection('persons')
      .getFullList<PersonRecord>({ filter: this.admin.filter('number = {:number}', { number }) });
    return items[0] ?? null;
  }

  /** Deletes everything carrying this test's token (best effort, dependants first). */
  async cleanup(): Promise<void> {
    const pb = this.admin;
    const t = { t: this.token };
    const remove = async (collection: string, filter: string) => {
      try {
        const items = await pb.collection(collection).getFullList({ filter: pb.filter(filter, t), fields: 'id', batch: 500 });
        for (const item of items) await pb.collection(collection).delete(item.id).catch(() => undefined);
      } catch {
        // cleanup must never fail a test
      }
    };
    await remove(
      'bookings',
      'person.number ~ {:t} || person.name ~ {:t} || offering.name ~ {:t} || offering.group.name ~ {:t} || createdBy.username ~ {:t}',
    );
    await remove('persons', 'number ~ {:t} || name ~ {:t} || nickname ~ {:t}');
    await remove('offerings', 'name ~ {:t} || group.name ~ {:t}');
    await remove('groups', 'name ~ {:t}');
    await remove('users', 'username ~ {:t}');
  }
}
