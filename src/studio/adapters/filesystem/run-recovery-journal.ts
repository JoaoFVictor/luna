import { canonicalJson } from "../../../core/workflow/definition-digests.js";
import {
  StudioRunLaunchError,
  studioRunLaunchError
} from "../../application/runs/launch-errors.js";
import {
  NativeStudioRunRecoveryIntentSchema,
  type NativeStudioRunRecoveryIntent
} from "../native/run-recovery-intent.js";
import { ImmutableJobJournal } from "./immutable-job-journal.js";

const MAX_RECOVERY_INTENT_BYTES = 4 * 1024;

function recoveryError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    {},
    cause === undefined ? undefined : { cause }
  );
}

function recoveryCorruptionError(message: string, cause?: unknown): Error {
  return studioRunLaunchError(
    "studio_run_dispatch_failed",
    message,
    { recovery_journal_corruption: true },
    cause === undefined ? undefined : { cause }
  );
}

export function isNativeStudioRunRecoveryJournalCorruption(
  cause: unknown
): boolean {
  return cause instanceof StudioRunLaunchError &&
    cause.details.recovery_journal_corruption === true;
}

export interface NativeStudioRunRecoveryJournalPort {
  write(intent: NativeStudioRunRecoveryIntent): Promise<void>;
  read(runId: string): Promise<NativeStudioRunRecoveryIntent | undefined>;
}

export class NativeStudioRunRecoveryJournal
  implements NativeStudioRunRecoveryJournalPort
{
  readonly #journal: ImmutableJobJournal;

  constructor(options: { readonly queueRoot: string }) {
    this.#journal = new ImmutableJobJournal({
      queueRoot: options.queueRoot,
      fileName: "recovery.json",
      temporaryPrefix: "recovery",
      maximumBytes: MAX_RECOVERY_INTENT_BYTES,
      label: "Native run recovery intent",
      failure: recoveryError,
      corruption: recoveryCorruptionError
    });
  }

  async write(input: NativeStudioRunRecoveryIntent): Promise<void> {
    const intent = NativeStudioRunRecoveryIntentSchema.parse(input);
    await this.#journal.write(intent.run_id, canonicalJson(intent));
  }

  async read(runId: string): Promise<NativeStudioRunRecoveryIntent | undefined> {
    const content = await this.#journal.read(runId);
    if (content === undefined) {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (cause) {
      throw recoveryCorruptionError(
        "Native run recovery intent is not valid JSON",
        cause
      );
    }
    const parsed = NativeStudioRunRecoveryIntentSchema.safeParse(raw);
    if (!parsed.success) {
      throw recoveryCorruptionError("Native run recovery intent is invalid");
    }
    if (parsed.data.run_id !== runId) {
      throw recoveryCorruptionError(
        "Native run recovery intent has the wrong run id"
      );
    }
    return parsed.data;
  }
}
