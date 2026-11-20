/** Every mutating /api request must send this header (CSRF defence on top of SameSite=Strict cookies). */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'budget-track';

/** Body of every non-2xx JSON response from /api. */
export interface ApiErrorBody {
  code: string;
  message: string;
  /** Present for code "validation": messages per request field. */
  fieldErrors?: Record<string, string[]>;
  /** Present for code "validation": messages not tied to one field. */
  formErrors?: string[];
  /** Present for code "internal": quote it when reporting a bug. */
  requestId?: string;
}
