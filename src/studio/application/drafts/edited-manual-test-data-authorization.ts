import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import type { StudioDraftItem } from "../../contracts/draft-authoring.js";
import type { StudioManualTestData } from "../../contracts/manual-test-data.js";
import type { RunNodeOutputResponse } from "../../contracts/run-node-output.js";
import type { WorkflowExpressionFixtureSource } from "../../contracts/workflow-expression-fixtures.js";
import type { StudioDraftNodeOutputValidatorPort } from "../runs/launch-definition-ports.js";
import { reusableOutputSafety } from "../runs/reusable-output-safety.js";
import { StudioDraftTestDataAuthorizationError } from "./manual-test-data-authorization.js";

type EditedSource = Extract<
  WorkflowExpressionFixtureSource,
  { readonly kind: "edited_run_node_output" }
>;
type EditedManualTestData = StudioManualTestData & {
  readonly source: EditedSource;
};
type AvailableOutputResponse = Extract<
  RunNodeOutputResponse,
  { readonly availability: "available" }
>;
type AvailableOutput = AvailableOutputResponse & {
  readonly output: Extract<
    AvailableOutputResponse["output"],
    { readonly availability: "available" }
  >;
};

function fixtureDetails(
  draftId: string,
  selected: StudioManualTestData
) {
  return {
    draftId,
    fixtureName: selected.fixture_name,
    nodeId: selected.node_id
  };
}

export async function authorizeEditedManualTestData(input: {
  readonly current: StudioDraftItem;
  readonly draftId: string;
  readonly selected: EditedManualTestData;
  readonly response: AvailableOutput;
  readonly validateNodeOutput:
    | StudioDraftNodeOutputValidatorPort["validateDraftNodeOutput"]
    | undefined;
}): Promise<StudioManualTestData> {
  const { current, draftId, selected, response, validateNodeOutput } = input;
  const sourceHash = sha256Digest(response.output.value);
  const safe = reusableOutputSafety(selected.output);
  if (
    selected.source.source_output_hash !== sourceHash ||
    selected.source.output_hash !== selected.output_hash ||
    safe.changed ||
    validateNodeOutput === undefined
  ) {
    throw new StudioDraftTestDataAuthorizationError(
      "studio_draft_test_data_tampered",
      "The edited fixture is not authorized by its current source output",
      { details: fixtureDetails(draftId, selected) }
    );
  }
  try {
    await validateNodeOutput(
      { kind: "draft", draft_id: draftId, etag: current.etag },
      selected.node_id,
      selected.output
    );
  } catch (cause) {
    throw new StudioDraftTestDataAuthorizationError(
      "studio_draft_test_data_invalid",
      "The edited fixture does not match the current node output schema",
      { cause, details: fixtureDetails(draftId, selected) }
    );
  }
  return selected;
}
