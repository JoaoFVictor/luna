import { redactString } from "../../../core/security/redactor.js";

/**
 * Redacts the core token/header/env patterns plus simple JSON string fields.
 * This is deliberately labelled best-effort by every public DTO: arbitrary
 * secret detection is impossible without a data classification contract.
 */
export function redactStudioText(value: string): string {
  return redactString(value).replace(
    /("[A-Za-z0-9_.-]*(?:(?:token|secret|password|authorization)|(?:(?:api|client|private)[_-]?key))[A-Za-z0-9_.-]*"\s*:\s*)"(?:\\["\\/bfnrt]|\\u[a-fA-F0-9]{4}|[^"\\])*"/gi,
    '$1"[REDACTED]"'
  );
}
