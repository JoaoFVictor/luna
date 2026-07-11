import { runStoreError } from "./errors.js";

type SafeSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false };
};

export function parseRunContract<T>(
  schema: SafeSchema<T>,
  value: unknown,
  boundary: "catalog query" | "event request" | "ledger command"
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw runStoreError("run_invalid_input", `Run ${boundary} is invalid`);
  }
  return parsed.data;
}
