import type { JsonValue } from "../../../core/json/value.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import { StudioExpressionFixtureSchema } from "../../contracts/expression-evaluation.js";
import type { StudioDraftItem } from "../../contracts/draft-authoring.js";
import {
  DespinRunNodeOutputFixtureRequestSchema,
  EditRunNodeOutputFixtureRequestSchema,
  runNodeOutputExpressionFixture,
  workflowExpressionFixtureSources,
  workflowExpressionFixtures,
  withWorkflowExpressionFixture,
  type DespinRunNodeOutputFixtureRequest,
  type EditRunNodeOutputFixtureRequest,
  type WorkflowExpressionFixtureSource
} from "../../contracts/workflow-expression-fixtures.js";
import type { StudioDraftNodeOutputValidatorPort } from "../runs/launch-definition-ports.js";
import type { RunNodeOutputService } from "../runs/node-output-service.js";
import { reusableOutputSafety } from "../runs/reusable-output-safety.js";
import type { StudioDraftAuthoringService } from "./authoring-service.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";

type DraftFixtureWriter = Pick<StudioDraftAuthoringService, "get" | "patch">;

function fixtureConflict(message: string): StudioDraftAuthoringError {
  return new StudioDraftAuthoringError(
    "studio_draft_authoring_fixture_conflict",
    message
  );
}

export class StudioEditedRunOutputFixtureService {
  readonly #outputs: Pick<RunNodeOutputService, "getWithRecord">;
  readonly #drafts: DraftFixtureWriter;
  readonly #validator: StudioDraftNodeOutputValidatorPort | undefined;

  constructor(options: {
    readonly outputs: Pick<RunNodeOutputService, "getWithRecord">;
    readonly drafts: DraftFixtureWriter;
    readonly validator?: StudioDraftNodeOutputValidatorPort;
  }) {
    this.#outputs = options.outputs;
    this.#drafts = options.drafts;
    this.#validator = options.validator;
  }

  async edit(
    draftId: string,
    input: EditRunNodeOutputFixtureRequest,
    ifMatch: string | undefined
  ): Promise<StudioDraftItem> {
    const request = EditRunNodeOutputFixtureRequestSchema.parse(input);
    const current = await this.#drafts.get(draftId);
    this.#assertPrecondition(current, ifMatch, "editing");
    if (current.primary_resource.kind !== "workflow") {
      throw fixtureConflict("Manual test output editing requires a workflow draft");
    }
    const source = workflowExpressionFixtureSources(current.layout)[request.fixture_name];
    const fixture = workflowExpressionFixtures(current.layout)[request.fixture_name];
    if (source === undefined || fixture === undefined) {
      throw fixtureConflict("The selected fixture is not pinned to an authorized run output");
    }
    if (source.redaction_changed) {
      throw fixtureConflict("Redacted run output cannot be edited into executable test data");
    }

    const sourceOutput = await this.#authorizedSourceOutput(current, source);
    const sourceOutputHash = sha256Digest(sourceOutput);
    if (
      source.kind === "edited_run_node_output" &&
      source.source_output_hash !== sourceOutputHash
    ) {
      throw fixtureConflict("The edited fixture source no longer matches its authoritative output");
    }

    const output = this.#safeEditedOutput(request.output);
    await this.#validateCurrentNodeOutput(current, source.node_id, output);
    const outputHash = sha256Digest(output);
    const editedSource: WorkflowExpressionFixtureSource = {
      ...this.#sourceIdentity(source),
      kind: "edited_run_node_output",
      redaction_changed: false,
      source_output_hash: sourceOutputHash,
      output_hash: outputHash,
      edited_at: new Date().toISOString()
    };
    const layout = this.#editedLayout(
      current,
      request.fixture_name,
      source.node_id,
      output,
      editedSource
    );
    return await this.#drafts.patch(draftId, { layout }, ifMatch);
  }

  async despin(
    draftId: string,
    input: DespinRunNodeOutputFixtureRequest,
    ifMatch: string | undefined
  ): Promise<StudioDraftItem> {
    const request = DespinRunNodeOutputFixtureRequestSchema.parse(input);
    const current = await this.#drafts.get(draftId);
    this.#assertPrecondition(current, ifMatch, "despinning");
    const fixture = workflowExpressionFixtures(current.layout)[request.fixture_name];
    const source = workflowExpressionFixtureSources(current.layout)[request.fixture_name];
    if (fixture === undefined || source === undefined) {
      throw fixtureConflict("The selected fixture is not pinned");
    }
    const layout = withWorkflowExpressionFixture(
      current.layout,
      request.fixture_name,
      fixture
    );
    return await this.#drafts.patch(draftId, { layout }, ifMatch);
  }

  #safeEditedOutput(value: JsonValue): JsonValue {
    const safe = reusableOutputSafety(value);
    if (safe.changed) {
      throw fixtureConflict(
        "The edited output contains credentials or sensitive values and cannot be saved as executable test data"
      );
    }
    return StudioExpressionFixtureSchema.parse(safe.value);
  }

  async #validateCurrentNodeOutput(
    current: StudioDraftItem,
    nodeId: string,
    output: JsonValue
  ): Promise<void> {
    if (this.#validator === undefined) {
      throw fixtureConflict("Draft node output schema validation is unavailable");
    }
    try {
      await this.#validator.validateDraftNodeOutput(
        { kind: "draft", draft_id: current.draft_id, etag: current.etag },
        nodeId,
        output
      );
    } catch (cause) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_fixture_conflict",
        "The edited output does not match the current node output schema",
        { cause }
      );
    }
  }

  #editedLayout(
    current: StudioDraftItem,
    fixtureName: string,
    nodeId: string,
    output: JsonValue,
    source: WorkflowExpressionFixtureSource
  ): JsonValue {
    try {
      return withWorkflowExpressionFixture(
        current.layout,
        fixtureName,
        runNodeOutputExpressionFixture(nodeId, output),
        source
      );
    } catch (cause) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_fixture_too_large",
        "The edited output exceeds the executable fixture limits",
        { cause }
      );
    }
  }

  #assertPrecondition(
    current: StudioDraftItem,
    ifMatch: string | undefined,
    operation: string
  ): void {
    if (ifMatch === undefined) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_precondition_required",
        `Run output fixture ${operation} requires If-Match`,
        { details: { draftId: current.draft_id } }
      );
    }
    if (ifMatch !== current.etag) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_precondition_failed",
        `The Studio draft changed after run output fixture ${operation} was prepared`,
        { details: { draftId: current.draft_id, actualEtag: current.etag } }
      );
    }
  }

  #sourceIdentity(source: WorkflowExpressionFixtureSource) {
    return {
      run_id: source.run_id,
      workflow_id: source.workflow_id,
      node_id: source.node_id,
      graph_hash: source.graph_hash,
      outcome_hash: source.outcome_hash,
      workflow_revision: source.workflow_revision,
      definition_bundle_hash: source.definition_bundle_hash,
      captured_at: source.captured_at,
      definition_source: source.definition_source
    };
  }

  async #authorizedSourceOutput(
    current: StudioDraftItem,
    source: WorkflowExpressionFixtureSource
  ): Promise<JsonValue> {
    const { response, record } = await this.#outputs.getWithRecord(
      source.run_id,
      source.node_id
    );
    if (
      record === undefined ||
      response.availability !== "available" ||
      response.output.availability !== "available" ||
      response.output.redaction.changed
    ) {
      throw fixtureConflict("The fixture source output is unavailable or redacted");
    }
    const capturedAt = record.finished_at ?? record.updated_at;
    const sameDefinitionSource =
      record.definition_source?.kind === source.definition_source.kind &&
      (record.definition_source?.kind === "installed" || (
        source.definition_source.kind === "draft" &&
        record.definition_source.draft_id === source.definition_source.draft_id &&
        record.definition_source.etag === source.definition_source.etag
      ));
    if (
      current.primary_resource.kind !== "workflow" ||
      current.primary_resource.id !== source.workflow_id ||
      record.run_id !== source.run_id ||
      record.workflow_id !== source.workflow_id ||
      record.workflow_revision !== source.workflow_revision ||
      record.definition_bundle_hash !== source.definition_bundle_hash ||
      capturedAt !== source.captured_at ||
      !sameDefinitionSource ||
      response.run.run_id !== record.run_id ||
      response.run.workflow_id !== record.workflow_id ||
      response.node_id !== source.node_id ||
      response.graph_hash !== source.graph_hash ||
      response.outcome_hash !== source.outcome_hash
    ) {
      throw fixtureConflict("The fixture provenance no longer matches its authoritative run output");
    }
    return response.output.value;
  }
}
