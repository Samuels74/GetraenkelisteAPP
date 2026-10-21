import { ClientResponseError } from 'pocketbase';
import { describeError } from '../../lib/errors';
import { formLevelError } from './formErrors';

const serverError = (data: Record<string, unknown>, message = 'Failed to create record.') =>
  describeError(new ClientResponseError({ status: 400, response: { status: 400, message, data } }), 'offerings');

describe('formLevelError', () => {
  it('stays empty when every field error is shown under its field', () => {
    const info = serverError({
      name: { code: 'validation_not_unique', message: 'Value must be unique.' },
      group: { code: 'validation_not_unique', message: 'Value must be unique.' },
    });
    expect(formLevelError(info, ['name', 'group', 'priceCents'])).toBeNull();
  });

  it('shows the whole message when a field error has no field in the form', () => {
    const info = serverError({
      name: { code: 'validation_required', message: 'Cannot be blank.' },
      sortOrder: { code: 'validation_min_number_constraint', message: 'Must be at least 0.', params: { min: 0 } },
    });
    expect(formLevelError(info, ['name'])).toBe(info.message);
    expect(info.message).toContain('Reihenfolge');
  });

  it('shows messages without field errors (permissions, connection)', () => {
    const info = describeError(new ClientResponseError({ status: 0, response: {} }));
    expect(formLevelError(info, ['name'])).toBe('Keine Verbindung zum Server. Bitte prüfe die Netzwerkverbindung.');
  });
});
