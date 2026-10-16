export type CmsErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "NETWORK"
  | "CONFIG"
  | "AI_UNAVAILABLE"
  | "BLOCKED";

export class CmsError extends Error {
  readonly code: CmsErrorCode;
  readonly details: unknown;

  constructor(code: CmsErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CmsError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: CmsErrorCode; message: string; details?: unknown } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isCmsError(err: unknown): err is CmsError {
  return err instanceof CmsError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
