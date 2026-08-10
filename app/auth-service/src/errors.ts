/**
 * A single error shape for the whole stack:
 *
 *   { "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [...] } }
 *
 * The API test suite asserts on `error.code` rather than on prose, so error
 * messages can be reworded without breaking tests.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'MALFORMED_JSON'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code: ErrorCode, message: string, details?: unknown): ApiError {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(code: ErrorCode, message: string): ApiError {
    return new ApiError(401, code, message);
  }

  static conflict(code: ErrorCode, message: string): ApiError {
    return new ApiError(409, code, message);
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  toBody(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}
