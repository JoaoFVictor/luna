import type { StudioDraftLockPort } from "../../application/drafts/persistence.js";

export type StudioDraftLockReleaseErrorReporter = (
  error: unknown,
  context: {
    readonly resource: string;
    readonly operationSucceeded: boolean;
  }
) => Promise<void> | void;

export async function withExclusiveStudioDraftLock<T>(input: {
  readonly lockManager: StudioDraftLockPort;
  readonly resource: string;
  readonly operation: () => Promise<T>;
  readonly onReleaseError?: StudioDraftLockReleaseErrorReporter;
}): Promise<T> {
  const release = await input.lockManager.acquire(input.resource, "exclusive");
  let outcome:
    | { readonly succeeded: true; readonly value: T }
    | { readonly succeeded: false; readonly error: unknown };
  try {
    outcome = { succeeded: true, value: await input.operation() };
  } catch (cause) {
    outcome = { succeeded: false, error: cause };
  }

  try {
    await release();
  } catch (releaseError) {
    reportLockReleaseError(input.onReleaseError, releaseError, {
      resource: input.resource,
      operationSucceeded: outcome.succeeded
    });
  }

  if (!outcome.succeeded) {
    throw outcome.error;
  }
  return outcome.value;
}

function reportLockReleaseError(
  reporter: StudioDraftLockReleaseErrorReporter | undefined,
  error: unknown,
  context: {
    readonly resource: string;
    readonly operationSucceeded: boolean;
  }
): void {
  try {
    const notification = reporter?.(error, context);
    if (notification !== undefined) {
      void Promise.resolve(notification).catch(() => undefined);
    }
  } catch {
    // Audit sinks are deliberately best-effort at this boundary. A callback
    // failure cannot rewrite an already completed storage outcome.
  }
}
