export type LockDiagnosticLogger = (
  level: "info" | "warn" | "error",
  event: string,
  attributes: Record<string, unknown>
) => void;
