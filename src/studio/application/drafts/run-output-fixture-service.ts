import type { StudioDraftItem } from "../../contracts/draft-authoring.js";
import type { JsonValue } from "../../../core/json/value.js";
import {
  PromoteRunNodeOutputFixtureRequestSchema,
  runNodeOutputExpressionFixture,
  withWorkflowExpressionFixture,
  type DespinRunNodeOutputFixtureRequest,
  type EditRunNodeOutputFixtureRequest,
  type PromoteRunNodeOutputFixtureRequest,
  type WorkflowExpressionFixtureSource
} from "../../contracts/workflow-expression-fixtures.js";
import type { RunNodeOutputService } from "../runs/node-output-service.js";
import type { StudioDraftNodeOutputValidatorPort } from "../runs/launch-definition-ports.js";
import type { StudioDraftAuthoringService } from "./authoring-service.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";
import { StudioEditedRunOutputFixtureService } from "./edited-run-output-fixture-service.js";

type DraftFixtureWriter = Pick<StudioDraftAuthoringService, "get" | "patch">;

function fixtureConflict(message: string): StudioDraftAuthoringError {
  return new StudioDraftAuthoringError(
    "studio_draft_authoring_fixture_conflict",
    message
  );
}

export class StudioRunOutputFixtureService {
  readonly #outputs: Pick<RunNodeOutputService, "getWithRecord">;
  readonly #drafts: DraftFixtureWriter;
  readonly #editing: StudioEditedRunOutputFixtureService;

  constructor(options: {
    readonly outputs: Pick<RunNodeOutputService, "getWithRecord">;
    readonly drafts: DraftFixtureWriter;
    readonly validator?: StudioDraftNodeOutputValidatorPort;
  }) {
    this.#outputs = options.outputs;
    this.#drafts = options.drafts;
    this.#editing = new StudioEditedRunOutputFixtureService(options);
  }

  async edit(
    draftId: string,
    input: EditRunNodeOutputFixtureRequest,
    ifMatch: string | undefined
  ): Promise<StudioDraftItem> {
    return await this.#editing.edit(draftId, input, ifMatch);
  }

  async despin(
    draftId: string,
    input: DespinRunNodeOutputFixtureRequest,
    ifMatch: string | undefined
  ): Promise<StudioDraftItem> {
    return await this.#editing.despin(draftId, input, ifMatch);
  }

  async promote(
    draftId: string,
    input: PromoteRunNodeOutputFixtureRequest,
    ifMatch: string | undefined
  ): Promise<StudioDraftItem> {
    const request = PromoteRunNodeOutputFixtureRequestSchema.parse(input);
    const current = await this.#drafts.get(draftId);
    if (ifMatch === undefined) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_precondition_required",
        "Run output promotion requires If-Match",
        { details: { draftId } }
      );
    }
    if (ifMatch !== current.etag) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_precondition_failed",
        "The Studio draft changed after the run output promotion was prepared",
        { details: { draftId, actualEtag: current.etag } }
      );
    }

    const material = await this.#outputs.getWithRecord(
      request.run_id,
      request.node_id
    );
    const response = material.response;
    const record = material.record;
    if (
      record === undefined ||
      record.definition_source === undefined ||
      record.workflow_revision === undefined ||
      record.definition_bundle_hash === undefined
    ) {
      throw fixtureConflict(
        "The fixture source run does not have authoritative definition metadata"
      );
    }
    if (
      current.primary_resource.kind !== "workflow" ||
      current.primary_resource.id !== record.workflow_id
    ) {
      throw fixtureConflict(
        "The fixture source workflow does not match the target draft"
      );
    }

    if (
      record.run_id !== request.run_id ||
      response.run.run_id !== record.run_id ||
      response.run.workflow_id !== record.workflow_id ||
      response.node_id !== request.node_id
    ) {
      throw fixtureConflict(
        "The fixture source identity does not match the authorized output"
      );
    }

    if (
      response.availability !== "available" ||
      response.output.availability !== "available"
    ) {
      throw fixtureConflict(
        "The selected run node does not have a reusable output snapshot"
      );
    }
    if (
      response.graph_hash !== request.graph_hash ||
      response.outcome_hash !== request.outcome_hash
    ) {
      throw fixtureConflict(
        "The run output identity changed after the fixture was prepared"
      );
    }

    let fixture: JsonValue;
    try {
      fixture = runNodeOutputExpressionFixture(
        request.node_id,
        response.output.value
      );
    } catch (cause) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_fixture_too_large",
        "The run output exceeds the expression fixture limits",
        { cause }
      );
    }

    const source: WorkflowExpressionFixtureSource = {
      kind: "run_node_output",
      run_id: record.run_id,
      workflow_id: record.workflow_id,
      node_id: request.node_id,
      graph_hash: response.graph_hash,
      outcome_hash: response.outcome_hash,
      workflow_revision: record.workflow_revision,
      definition_bundle_hash: record.definition_bundle_hash,
      captured_at: record.finished_at ?? record.updated_at,
      redaction_changed: response.output.redaction.changed,
      definition_source: record.definition_source
    };
    let layout: JsonValue;
    try {
      layout = withWorkflowExpressionFixture(
        current.layout,
        request.fixture_name,
        fixture,
        source
      );
    } catch (cause) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_fixture_conflict",
        "The draft cannot accept this expression fixture",
        { cause }
      );
    }
    return await this.#drafts.patch(draftId, { layout }, ifMatch);
  }

}
