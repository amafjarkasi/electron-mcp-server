export const ERROR_CODES = [
  "STORE_NOT_FOUND",
  "STORE_NO_CRX",
  "NOT_CRX",
  "ZIP_SLIP",
  "INVALID_INPUT",
  "MANIFEST_MISSING",
  "MANIFEST_INVALID",
  "DOWNLOAD_TOO_LARGE",
  "MIMO_PLAN_MISMATCH",
  "NEEDS_OWNERSHIP",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CrxReError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CrxReError";
    this.code = code;
  }
}

export function isCrxReError(error: unknown): error is CrxReError {
  return error instanceof CrxReError;
}
