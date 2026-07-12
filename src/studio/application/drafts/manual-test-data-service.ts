import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import type { StudioDraftItem } from "../../contracts/draft-authoring.js";
import {
  StudioDraftTestDataSelectionsSchema,
  StudioManualTestDataSchema,
  StudioManualTestDataListSchema,
  type StudioDraftTestDataSelections,
  type StudioDraftTestDataSelectionsInput,
  type StudioManualTestData,
  type StudioManualTestDataList
} from "../../contracts/manual-test-data.js";
import { manualTestDataFromWorkflowLayout } from "./manual-test-data-material.js";
import type { StudioRunDefinitionSource } from "../../contracts/run-definition-source.js";
import type { RunNodeOutputResponse } from "../../contracts/run-node-output.js";
import type { RunRecord } from "../../contracts/runs.js";
import {
  StudioRunLaunchError
} from "../runs/launch-errors.js";
import type { RunNodeOutputService } from "../runs/node-output-service.js";
import type { StudioDraftRunDefinitionPort } from "../runs/launch-definition-ports.js";
import type { StudioDraftNodeOutputValidatorPort } from "../runs/launch-definition-ports.js";
import {
  StudioDraftTestDataAuthorizationError,
  type StudioDraftTestDataAuthorizationErrorCode,
  type StudioDraftTestDataAuthorizationPort
} from "./manual-test-data-authorization.js";
import { authorizeEditedManualTestData } from "./edited-manual-test-data-authorization.js";

type DraftTestDataReader = {
  get(draftId: string): Promise<StudioDraftItem>;
};

type AuthorizedOutputRead = Pick<RunNodeOutputService, "getWithRecord">;
type AvailableOutputResponse = Extract<
  RunNodeOutputResponse,
  { readonly availability: "available" }
>;
type AuthorizationErrorOptions = {
  readonly cause?: unknown;
  readonly details?: StudioDraftTestDataAuthorizationError["details"];
};

function authorizationError(
  code: StudioDraftTestDataAuthorizationErrorCode,
  message: string,
  options: AuthorizationErrorOptions = {}
): StudioDraftTestDataAuthorizationError {
  return new StudioDraftTestDataAuthorizationError(code, message, options);
}

function sameDefinitionSource(
  left: StudioRunDefinitionSource | undefined,
  right: StudioRunDefinitionSource
): boolean {
  if (left?.kind !== right.kind) return false;
  return left.kind === "installed" || (
    right.kind === "draft" &&
    left.draft_id === right.draft_id &&
    left.etag === right.etag
  );
}

function sourceCaptureTimestamp(record: {
  readonly finished_at?: string;
  readonly updated_at: string;
}): string {
  return record.finished_at ?? record.updated_at;
}

export class StudioDraftTestDataService
  implements StudioDraftTestDataAuthorizationPort
{
  readonly #drafts: DraftTestDataReader;
  readonly #definitions: StudioDraftRunDefinitionPort &
    Partial<StudioDraftNodeOutputValidatorPort>;
  readonly #outputs: AuthorizedOutputRead;

  constructor(options: {
    readonly drafts: DraftTestDataReader;
    readonly definitions: StudioDraftRunDefinitionPort &
      Partial<StudioDraftNodeOutputValidatorPort>;
    readonly outputs: AuthorizedOutputRead;
  }) {
    this.#drafts = options.drafts;
    this.#definitions = options.definitions;
    this.#outputs = options.outputs;
  }

  async authorize(
    draftId: string,
    input: StudioDraftTestDataSelectionsInput,
    ifMatch: string | undefined
  ): Promise<StudioManualTestDataList> {
    const selections = StudioDraftTestDataSelectionsSchema.parse(input);
    const current = await this.#drafts.get(draftId);
    this.#assertPrecondition(current, ifMatch);
    if (current.primary_resource.kind !== "workflow") {
      throw authorizationError(
        "studio_draft_test_data_definition_mismatch",
        "Manual workflow test data requires a workflow draft",
        { details: { draftId } }
      );
    }

    const selected = selections.map((selection) =>
      this.#readSelectedFixture(current, draftId, selection)
    );
    this.#assertDistinctNodes(draftId, selected);

    const definitionSource = {
      kind: "draft" as const,
      draft_id: draftId,
      etag: current.etag
    };
    const definition = await this.#loadCurrentDefinition(
      current,
      selected[0],
      definitionSource
    );
    selected.forEach((testData) =>
      this.#assertCurrentDefinition(current, testData, definition)
    );

    const authorized = await Promise.all(selected.map(async (testData) =>
      await this.#authorizeFixture(current, draftId, testData)
    ));
    return StudioManualTestDataListSchema.parse(authorized);
  }

  #readSelectedFixture(
    current: StudioDraftItem,
    draftId: string,
    selection: StudioDraftTestDataSelections[number]
  ): StudioManualTestData {
    try {
      return manualTestDataFromWorkflowLayout(current.layout, selection);
    } catch (cause) {
      throw authorizationError(
        "studio_draft_test_data_invalid",
        "The selected draft fixture is not executable manual test data",
        {
          cause,
          details: { draftId, fixtureName: selection.fixture_name }
        }
      );
    }
  }

  #assertDistinctNodes(
    draftId: string,
    selected: readonly StudioManualTestData[]
  ): void {
    const nodeIds = new Set<string>();
    for (const testData of selected) {
      if (nodeIds.has(testData.node_id)) {
        throw authorizationError(
          "studio_draft_test_data_invalid",
          "A workflow node can have only one active manual test output",
          {
            details: {
              draftId,
              fixtureName: testData.fixture_name,
              nodeId: testData.node_id
            }
          }
        );
      }
      nodeIds.add(testData.node_id);
    }
  }

  async #authorizeFixture(
    current: StudioDraftItem,
    draftId: string,
    selected: StudioManualTestData
  ): Promise<StudioManualTestData> {
    const authorized = await this.#outputs.getWithRecord(
      selected.source.run_id,
      selected.source.node_id
    );
    const response = authorized.response;
    const record = authorized.record;
    if (
      record === undefined ||
      response.availability !== "available" ||
      response.output.availability !== "available"
    ) {
      throw authorizationError(
        "studio_draft_test_data_unavailable",
        "The source run output is no longer available for authorization",
        {
          details: {
            draftId,
            fixtureName: selected.fixture_name,
            nodeId: selected.node_id
          }
        }
      );
    }
    const availableResponse = { ...response, output: response.output };

    if (
      selected.source.redaction_changed ||
      response.output.redaction.changed
    ) {
      throw authorizationError(
        "studio_draft_test_data_invalid",
        "Redacted run output cannot substitute a workflow node",
        {
          details: {
            draftId,
            fixtureName: selected.fixture_name,
            nodeId: selected.node_id
          }
        }
      );
    }

    this.#assertAuthorizedIdentity(current, selected, record, availableResponse);
    if (selected.source.kind === "edited_run_node_output") {
      const editedSelection = { ...selected, source: selected.source };
      return await authorizeEditedManualTestData({
        current,
        draftId,
        selected: editedSelection,
        response: availableResponse,
        validateNodeOutput: this.#definitions.validateDraftNodeOutput?.bind(
          this.#definitions
        )
      });
    }
    let authorizedOutput: StudioManualTestData;
    try {
      authorizedOutput = StudioManualTestDataSchema.parse({
        ...selected,
        output: response.output.value,
        output_hash: sha256Digest(response.output.value)
      });
    } catch (cause) {
      throw authorizationError(
        "studio_draft_test_data_too_large",
        "The authorized output exceeds the manual test data limits",
        {
          cause,
          details: {
            draftId,
            fixtureName: selected.fixture_name,
            nodeId: selected.node_id
          }
        }
      );
    }
    if (authorizedOutput.output_hash !== selected.output_hash) {
      throw authorizationError(
        "studio_draft_test_data_tampered",
        "The stored fixture output does not match its authorized run output",
        {
          details: {
            draftId,
            fixtureName: selected.fixture_name,
            nodeId: selected.node_id
          }
        }
      );
    }
    return authorizedOutput;
  }

  #assertPrecondition(
    current: StudioDraftItem,
    ifMatch: string | undefined
  ): void {
    if (ifMatch === undefined) {
      throw authorizationError(
        "studio_draft_test_data_precondition_required",
        "Draft test data authorization requires If-Match",
        { details: { draftId: current.draft_id } }
      );
    }
    if (ifMatch !== current.etag) {
      throw authorizationError(
        "studio_draft_test_data_precondition_failed",
        "The draft changed after test data selection was prepared",
        {
          details: {
            draftId: current.draft_id,
            actualEtag: current.etag
          }
        }
      );
    }
  }

  #assertCurrentDefinition(
    current: StudioDraftItem,
    selected: StudioManualTestData,
    definition: Awaited<ReturnType<StudioDraftRunDefinitionPort["loadDraft"]>>
  ): void {
    if (
      definition.workflowId !== current.primary_resource.id ||
      selected.source.workflow_id !== definition.workflowId ||
      selected.source.workflow_revision !== definition.workflowRevision ||
      selected.source.definition_bundle_hash !== definition.definitionBundleHash
    ) {
      throw authorizationError(
        "studio_draft_test_data_definition_mismatch",
        "The fixture was captured from a different workflow definition",
        {
          details: {
            draftId: current.draft_id,
            fixtureName: selected.fixture_name,
            nodeId: selected.node_id
          }
        }
      );
    }
  }

  async #loadCurrentDefinition(
    current: StudioDraftItem,
    selected: StudioManualTestData,
    source: Extract<StudioRunDefinitionSource, { kind: "draft" }>
  ): Promise<Awaited<ReturnType<StudioDraftRunDefinitionPort["loadDraft"]>>> {
    try {
      return await this.#definitions.loadDraft(source);
    } catch (cause) {
      if (
        cause instanceof StudioRunLaunchError &&
        cause.code === "studio_run_plan_stale"
      ) {
        throw authorizationError(
          "studio_draft_test_data_stale",
          "The workflow draft changed during test data authorization",
          {
            cause,
            details: {
              draftId: current.draft_id,
              fixtureName: selected.fixture_name,
              nodeId: selected.node_id
            }
          }
        );
      }
      throw cause;
    }
  }

  #assertAuthorizedIdentity(
    current: StudioDraftItem,
    selected: StudioManualTestData,
    record: RunRecord,
    response: AvailableOutputResponse
  ): void {
    const source = selected.source;
    const identityMatches =
      record.run_id === source.run_id &&
      record.workflow_id === source.workflow_id &&
      record.workflow_revision === source.workflow_revision &&
      record.definition_bundle_hash === source.definition_bundle_hash &&
      sourceCaptureTimestamp(record) === source.captured_at &&
      sameDefinitionSource(record.definition_source, source.definition_source) &&
      response.run.run_id === record.run_id &&
      response.run.workflow_id === record.workflow_id &&
      response.run.workflow_revision === record.workflow_revision &&
      response.run.definition_bundle_hash === record.definition_bundle_hash &&
      response.node_id === source.node_id &&
      response.graph_hash === source.graph_hash &&
      response.outcome_hash === source.outcome_hash;
    if (!identityMatches) {
      throw authorizationError(
        "studio_draft_test_data_stale",
        "The selected fixture no longer matches its authoritative run outcome",
        {
          details: {
            draftId: current.draft_id,
            fixtureName: selected.fixture_name,
            nodeId: selected.node_id
          }
        }
      );
    }
  }
}
