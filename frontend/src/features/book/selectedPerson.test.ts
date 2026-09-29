import { ClientResponseError } from 'pocketbase';
import {
  getSelectedPersonId,
  isPersonConfirmedGone,
  SELECTED_PERSON_KEY,
  setSelectedPersonId,
} from './selectedPerson';

const notFound = () => Promise.reject(new ClientResponseError({ status: 404, response: {} }));

describe('selected person storage', () => {
  it('persists the selection in localStorage (gl.selectedPersonId)', () => {
    setSelectedPersonId('p1');
    expect(localStorage.getItem(SELECTED_PERSON_KEY)).toBe('p1');
    expect(getSelectedPersonId()).toBe('p1');
    setSelectedPersonId(null);
    expect(localStorage.getItem(SELECTED_PERSON_KEY)).toBeNull();
  });
});

describe('isPersonConfirmedGone', () => {
  it('is true only with a valid session and a 404 for the person', async () => {
    expect(await isPersonConfirmedGone('p1', { checkSession: async () => 'valid', fetchPerson: notFound })).toBe(true);
  });

  it('never drops the selection because of an auth problem', async () => {
    const fetchPerson = vi.fn(notFound);
    expect(await isPersonConfirmedGone('p1', { checkSession: async () => 'invalid', fetchPerson })).toBe(false);
    expect(await isPersonConfirmedGone('p1', { checkSession: async () => 'unknown', fetchPerson })).toBe(false);
    expect(fetchPerson).not.toHaveBeenCalled();
  });

  it('keeps the selection when the person still exists or the server is unreachable', async () => {
    expect(await isPersonConfirmedGone('p1', { checkSession: async () => 'valid', fetchPerson: async () => ({}) })).toBe(
      false,
    );
    const offline = () => Promise.reject(new ClientResponseError({ status: 0, response: {} }));
    expect(await isPersonConfirmedGone('p1', { checkSession: async () => 'valid', fetchPerson: offline })).toBe(false);
  });
});
