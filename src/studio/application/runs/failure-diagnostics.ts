import type {
  RunFailureCategory,
  RunFailureDiagnostics,
  RunFailureRetryability
} from "../../contracts/runs.js";

type UnknownRecord = Record<string, unknown>;

type FailureDiagnosticInput = {
  readonly cause: unknown;
  readonly code?: string;
  readonly certainty?: "known" | "unknown";
};

const SAFE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const SAFE_OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const SENSITIVE_TOKEN_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = /((?:authorization|api[_-]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?)[^,\s]+/gi;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function stringValue(value: unknown, max = 256): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

function safeCode(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate !== undefined && SAFE_CODE_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function safeOperation(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate !== undefined && SAFE_OPERATION_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function safeMessage(value: unknown): string | undefined {
  const candidate = stringValue(value, 1_024);
  if (candidate === undefined) {
    return undefined;
  }
  return candidate
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1[redacted]")
    .replace(SENSITIVE_TOKEN_PATTERN, (match) => `${match.split(/\s+/, 1)[0]} [redacted]`);
}

function errorCode(value: unknown): string | undefined {
  return safeCode(record(value)?.code);
}

function errorMessage(value: unknown): string | undefined {
  return safeMessage(record(value)?.message);
}

function nestedCause(value: unknown): unknown {
  const candidate = record(value);
  if (candidate === undefined) {
    return undefined;
  }
  const details = record(candidate.details);
  return details?.cause ?? candidate.cause;
}

function statusCodeFrom(value: unknown): number | undefined {
  const candidate = record(value);
  if (candidate === undefined) {
    return undefined;
  }
  for (const key of ["status_code", "statusCode", "http_status", "httpStatus"]) {
    const status = candidate[key];
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return undefined;
}

function statusCodeFromText(value: unknown): number | undefined {
  const text = stringValue(value, 4_096);
  if (text === undefined) {
    return undefined;
  }
  const match = text.match(/\b(?:HTTP(?:\s+status)?|status(?:[_-]code)?)\s*[:=]?\s*([1-5]\d\d)\b/i);
  if (match === null) {
    return undefined;
  }
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : undefined;
}

function explicitCategory(value: unknown): RunFailureCategory | undefined {
  const candidate = stringValue(value);
  if (candidate === undefined) {
    return undefined;
  }
  const categories: readonly RunFailureCategory[] = [
    "configuration",
    "validation",
    "authentication",
    "authorization",
    "dependency",
    "transport",
    "rate_limit",
    "timeout",
    "runtime",
    "external",
    "unknown"
  ];
  return categories.includes(candidate as RunFailureCategory)
    ? candidate as RunFailureCategory
    : undefined;
}

function categoryFrom(
  code: string | undefined,
  statusCode: number | undefined,
  cause: unknown
): RunFailureCategory {
  const details = record(cause)?.details;
  const explicit = explicitCategory(record(cause)?.category) ??
    explicitCategory(record(details)?.category);
  if (explicit !== undefined) {
    return explicit;
  }

  const normalized = `${code ?? ""} ${errorCode(cause) ?? ""}`.toLowerCase();
  if (normalized.includes("runtime") || normalized.startsWith("studio_runtime")) {
    return "runtime";
  }
  if (normalized.includes("outcome_unknown") || normalized.includes("acceptance_unknown")) {
    return "external";
  }
  if (normalized.includes("authn") || normalized.includes("authentication") ||
    normalized.includes("credential")) {
    return "authentication";
  }
  if (normalized.includes("authz") || normalized.includes("authorization") ||
    normalized.includes("permission") || normalized.includes("forbidden")) {
    return "authorization";
  }
  if (normalized.includes("config") || normalized.includes("not_configured")) {
    return "configuration";
  }
  if (normalized.includes("validation") || normalized.includes("input_invalid") ||
    normalized.includes("invalid")) {
    return "validation";
  }
  if (normalized.includes("rate_limit") || statusCode === 429) {
    return "rate_limit";
  }
  if (normalized.includes("timeout") || statusCode === 408 || statusCode === 504) {
    return "timeout";
  }
  if (normalized.includes("transport") || normalized.includes("network") ||
    normalized.includes("connection")) {
    return "transport";
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return "external";
  }
  if (statusCode !== undefined && statusCode >= 400) {
    return "dependency";
  }
  return "unknown";
}

function retryabilityFrom(
  certainty: "known" | "unknown",
  category: RunFailureCategory,
  code: string | undefined
): RunFailureRetryability {
  if (certainty === "unknown") {
    return "unsafe";
  }
  if (code?.includes("outcome_unknown") || code?.includes("acceptance_unknown")) {
    return "unsafe";
  }
  if (category === "validation" || category === "configuration") {
    return "conditional";
  }
  if (category === "timeout" || category === "transport" || category === "external") {
    return "conditional";
  }
  return "unknown";
}

/**
 * Projects an arbitrary runtime/provider exception into a deliberately small,
 * redacted diagnostic contract. This function is the only place where the
 * control plane interprets exception metadata; providers remain free to use
 * their own errors without leaking their shapes into Studio.
 */
export function failureDiagnosticsFrom({
  cause,
  code,
  certainty = "known"
}: FailureDiagnosticInput): RunFailureDiagnostics {
  const source = record(cause);
  const details = record(source?.details);
  const nested = nestedCause(cause);
  const nestedDetails = record(record(nested)?.details);
  const causeCode = errorCode(nested) ?? errorCode(cause);
  const statusCode = statusCodeFrom(cause) ??
    statusCodeFrom(details) ??
    statusCodeFrom(nested) ??
    statusCodeFrom(nestedDetails) ??
    statusCodeFromText(details?.stderr) ??
    statusCodeFromText(record(nestedDetails)?.stderr) ??
    statusCodeFromText(errorMessage(nested));
  const category = categoryFrom(code ?? errorCode(cause), statusCode, cause);
  const operationId = safeOperation(
    record(cause)?.operation_id ??
    record(cause)?.operation ??
    details?.operation_id ??
    details?.operation ??
    record(nested)?.operation_id ??
    record(nested)?.operation ??
    nestedDetails?.operation_id ??
    nestedDetails?.operation
  );
  const causeMessage = errorMessage(nested) ?? errorMessage(cause);
  const diagnostics: RunFailureDiagnostics = {
    category,
    retryability: retryabilityFrom(certainty, category, code ?? causeCode),
    ...(operationId === undefined ? {} : { operation_id: operationId }),
    ...(statusCode === undefined ? {} : { status_code: statusCode }),
    ...(causeCode === undefined && causeMessage === undefined
      ? {}
      : {
          cause: {
            ...(causeCode === undefined ? {} : { code: causeCode }),
            ...(causeMessage === undefined ? {} : { message: causeMessage })
          }
        }),
    certainty
  };
  return diagnostics;
}
