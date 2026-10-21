import type { ErrorInfo } from '../../lib/errors';

/**
 * The form-level message (FormError) for a server error whose field errors
 * are shown under the fields: none when every field error has its field
 * there – the alert would only repeat them –, otherwise the whole message.
 */
export function formLevelError(info: ErrorInfo, inlineFields: readonly string[]): string | null {
  const fields = Object.keys(info.fieldErrors);
  return fields.length > 0 && fields.every((field) => inlineFields.includes(field)) ? null : info.message;
}
