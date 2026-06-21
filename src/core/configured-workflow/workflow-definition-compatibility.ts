import path from "node:path";
import { loadYamlFile } from "../config/loader.js";
import { assertSafeSegment } from "../path-security.js";
import {
  loadWorkflowDefinitionFromMetadata,
  type WorkflowDefinition,
  type WorkflowMetadata,
  WorkflowMetadataSchema
} from "../workflow/definition.js";

function compatibilityError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeConfiguredWorkflowMetadata(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const observability = value.observability;
  if (!isRecord(observability)) {
    return value;
  }

  const exporters = observability.exporters;
  if (!isRecord(exporters) || !hasOwn(exporters, "flue_log")) {
    return value;
  }

  if (hasOwn(exporters, "runtime_log")) {
    throw compatibilityError(
      "Workflow observability exporters cannot configure both runtime_log and flue_log",
      "workflow_observability_exporter_duplicate"
    );
  }

  const { flue_log: flueLog, ...canonicalExporters } = exporters;

  return {
    ...value,
    observability: {
      ...observability,
      exporters: {
        ...canonicalExporters,
        runtime_log: flueLog
      }
    }
  };
}

const ConfiguredWorkflowMetadataSchema = {
  parse(value: unknown): WorkflowMetadata {
    return WorkflowMetadataSchema.parse(normalizeConfiguredWorkflowMetadata(value));
  }
};

export async function loadConfiguredWorkflowDefinition(
  workflowsRoot: string,
  workflowId: string
): Promise<WorkflowDefinition> {
  assertSafeSegment(workflowId);
  const directory = path.join(workflowsRoot, workflowId);
  const metadata = await loadYamlFile(
    path.join(directory, "workflow.yaml"),
    ConfiguredWorkflowMetadataSchema
  );

  return await loadWorkflowDefinitionFromMetadata({
    directory,
    metadata,
    workflowId
  });
}
