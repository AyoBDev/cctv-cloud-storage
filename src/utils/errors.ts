export const ErrorCodes = {
  // Auth
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // Resources
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  // Server
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode = 500) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }

  static unauthorized(message = 'Unauthorized'): AppError {
    return new AppError(ErrorCodes.UNAUTHORIZED, message, 401);
  }

  static forbidden(message = 'Forbidden'): AppError {
    return new AppError(ErrorCodes.FORBIDDEN, message, 403);
  }

  static notFound(message = 'Not found'): AppError {
    return new AppError(ErrorCodes.NOT_FOUND, message, 404);
  }

  static conflict(message: string): AppError {
    return new AppError(ErrorCodes.CONFLICT, message, 409);
  }

  static invalidCredentials(): AppError {
    return new AppError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid email or password', 401);
  }
}
