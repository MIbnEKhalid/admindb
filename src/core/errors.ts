/**
 * Typed domain errors and HTTP status mapping for admindb.
 */

export class AppError extends Error {
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.', details?: Record<string, unknown>) {
    super(message, 404, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Database is open in read-only mode — write operations are disabled.', details?: Record<string, unknown>) {
    super(message, 403, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 409, details);
  }
}
