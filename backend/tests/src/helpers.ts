import PocketBase, { ClientResponseError, type RecordModel } from "pocketbase";
import { expect, inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    pbUrl: string;
    superuser: { email: string; password: string };
  }
}

export const PB_URL = inject("pbUrl");

export const MESSAGES = {
  offeringHasBookings:
    "Dieses Angebot hat bereits Buchungen und kann nicht gelöscht werden. Deaktiviere es stattdessen.",
  groupHasOfferings: "Diese Gruppe enthält noch Angebote und kann nicht gelöscht werden.",
  personHasBookings: "Diese Person hat bereits Buchungen und kann nicht gelöscht werden.",
  userHasBookings:
    "Dieser Benutzer hat bereits Buchungen erfasst und kann nicht gelöscht werden. Deaktiviere das Konto stattdessen.",
  offeringInactive: "Dieses Angebot ist nicht aktiv.",
  ownRoleOrDisabled: "Du kannst deine eigene Rolle nicht ändern und dein eigenes Konto nicht deaktivieren.",
} as const;

export const DEFAULT_PASSWORD = "password123";

let sequence = 0;

/** Unique, lowercase identifier (valid username / person number). */
export function uid(prefix = "t"): string {
  sequence += 1;
  return `${prefix}${Date.now().toString(36)}${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function client(): PocketBase {
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  return pb;
}

export async function login(username: string, password: string): Promise<PocketBase> {
  const pb = client();
  await pb.collection("users").authWithPassword(username, password);
  return pb;
}

/** The seeded admin ("admin"/"admin"). Tests must not change its password/role. */
export function seededAdmin(): Promise<PocketBase> {
  return login("admin", "admin");
}

export async function superuser(): Promise<PocketBase> {
  const { email, password } = inject("superuser");
  const pb = client();
  await pb.collection("_superusers").authWithPassword(email, password);
  return pb;
}

export interface TestUser {
  record: RecordModel;
  username: string;
  password: string;
  /** client logged in as this user */
  pb: PocketBase;
}

/** Creates a user through the seeded admin and logs in as that user. */
export async function createUser(
  options: { role?: "admin" | "user"; name?: string; prefix?: string; password?: string } = {},
): Promise<TestUser> {
  const admin = await seededAdmin();
  const username = uid(options.prefix ?? "u");
  const password = options.password ?? DEFAULT_PASSWORD;
  const record = await admin.collection("users").create({
    username,
    password,
    passwordConfirm: password,
    role: options.role ?? "user",
    name: options.name ?? "",
  });
  return { record, username, password, pb: await login(username, password) };
}

export async function createGroup(admin: PocketBase, data: Record<string, unknown> = {}): Promise<RecordModel> {
  return admin.collection("groups").create({ name: uid("Gruppe "), sortOrder: 100, ...data });
}

export async function createOffering(
  admin: PocketBase,
  data: Record<string, unknown> = {},
): Promise<RecordModel> {
  const group = data.group ?? (await createGroup(admin)).id;
  return admin
    .collection("offerings")
    .create({ name: uid("Angebot "), priceCents: 100, active: true, sortOrder: 10, ...data, group });
}

export async function createPerson(pb: PocketBase, data: Record<string, unknown> = {}): Promise<RecordModel> {
  return pb.collection("persons").create({ number: uid("p"), name: "Test", nickname: "", ...data });
}

export async function book(
  pb: PocketBase,
  person: string,
  offering: string,
  quantity = 1,
  extra: Record<string, unknown> = {},
): Promise<RecordModel> {
  return pb.collection("bookings").create({ person, offering, quantity, ...extra });
}

export interface Totals {
  count: number;
  quantity: number;
  totalCents: number;
  perPerson: Array<{
    personId: string;
    number: string;
    name: string;
    nickname: string;
    count: number;
    quantity: number;
    totalCents: number;
  }>;
  perOffering: Array<{
    offeringId: string;
    name: string;
    groupId: string;
    groupName: string;
    count: number;
    quantity: number;
    totalCents: number;
  }>;
  perUser: Array<{
    userId: string;
    username: string;
    name: string;
    count: number;
    quantity: number;
    totalCents: number;
  }>;
}

export function totals(pb: PocketBase, query: Record<string, string> = {}): Promise<Totals> {
  return pb.send<Totals>("/api/app/totals", { query });
}

/** PocketBase datetime ("2026-01-31 12:00:00.123Z") -> ISO 8601 ("2026-01-31T12:00:00.123Z"). */
export function toIso(pbDateTime: string): string {
  return pbDateTime.replace(" ", "T");
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asserts that the request fails with the given HTTP status (and message). */
export async function expectApiError(
  request: Promise<unknown>,
  status: number,
  message?: string,
): Promise<ClientResponseError> {
  const error = await request.then(
    () => {
      throw new Error(`expected the request to fail with HTTP ${status}, but it succeeded`);
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ClientResponseError);
  const apiError = error as ClientResponseError;
  expect(apiError.status, JSON.stringify(apiError.response)).toBe(status);
  if (message !== undefined) {
    expect(apiError.response.message).toBe(message);
  }
  return apiError;
}
