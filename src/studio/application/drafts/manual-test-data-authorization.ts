import type {
  StudioDraftTestDataSelectionsInput,
  StudioManualTestDataList
} from "../../contracts/manual-test-data.js";

export type StudioDraftTestDataAuthorizationErrorCode =
  | "studio_draft_test_data_precondition_required"
  | "studio_draft_test_data_precondition_failed"
  | "studio_draft_test_data_invalid"
  | "studio_draft_test_data_unavailable"
  | "studio_draft_test_data_stale"
  | "studio_draft_test_data_tampered"
  | "studio_draft_test_data_definition_mismatch"
  | "studio_draft_test_data_too_large";

export class StudioDraftTestDataAuthorizationError extends Error {
  readonly code: StudioDraftTestDataAuthorizationErrorCode;
  readonly details: Readonly<{
    draftId?: string;
    actualEtag?: string;
    fixtureName?: string;
    nodeId?: string;
  }>;

  constructor(
    code: StudioDraftTestDataAuthorizationErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: StudioDraftTestDataAuthorizationError["details"];
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioDraftTestDataAuthorizationError";
    this.code = code;
    this.details = options.details ?? {};
  }
}

/**
 * Authorizes a deterministic set of named fixtures for one draft-test command.
 * Returned values are server-resolved execution material, never client input.
 */
export interface StudioDraftTestDataAuthorizationPort {
  authorize(
    draftId: string,
    selections: StudioDraftTestDataSelectionsInput,
    ifMatch: string | undefined
  ): Promise<StudioManualTestDataList>;
}
