import type { JsonValue } from "../../../core/json/value.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import {
  StudioDraftTestDataSelectionSchema,
  StudioManualTestDataSchema,
  type StudioDraftTestDataSelection,
  type StudioManualTestData
} from "../../contracts/manual-test-data.js";
import {
  workflowExpressionFixtureSources,
  workflowExpressionFixtures
} from "../../contracts/workflow-expression-fixtures.js";

function record(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function manualTestDataFromWorkflowLayout(
  layout: JsonValue | undefined,
  selection: StudioDraftTestDataSelection
): StudioManualTestData {
  const { fixture_name: fixtureName } =
    StudioDraftTestDataSelectionSchema.parse(selection);
  const fixture = workflowExpressionFixtures(layout)[fixtureName];
  const source = workflowExpressionFixtureSources(layout)[fixtureName];
  if (fixture === undefined || source === undefined) {
    throw new Error(
      "Os dados selecionados não têm uma saída de execução autorizada."
    );
  }
  if (source.redaction_changed) {
    throw new Error(
      "Uma saída redigida pode ser usada em preview, mas não pode substituir um node."
    );
  }
  if (!record(fixture) || !record(fixture.steps)) {
    throw new Error("Os dados selecionados não contêm outputs de node.");
  }
  const entries = Object.entries(fixture.steps);
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== source.node_id ||
    entries[0]?.[1] === undefined
  ) {
    throw new Error(
      "Os dados selecionados devem conter exatamente o output autorizado do node de origem."
    );
  }
  const output = entries[0][1];
  return StudioManualTestDataSchema.parse({
    kind: "draft_fixture",
    fixture_name: fixtureName,
    node_id: source.node_id,
    output,
    output_hash: sha256Digest(output),
    source
  });
}
