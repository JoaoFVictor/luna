import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { assertSafeSegment } from "../../../core/security/path.js";
import type { CapabilityRegistry } from "../../../core/capabilities/registry.js";
import {
  type WorkflowDefinition
} from "../../../core/workflow/definition.js";
import { loadWorkflowDefinitionWithAgentDigests } from "../../../capabilities/agents/workflow-definition-loader.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import {
  StudioCatalogDiagnosticSchema,
  type StudioCatalogDiagnostic
} from "../../contracts/catalog.js";
import {
  StudioWorkflowCatalogSchema,
  StudioWorkflowSummarySchema,
  type StudioWorkflowCatalog,
  type StudioWorkflowSummary
} from "../../contracts/workflow-catalog.js";
import { relativeCatalogFileReference } from "./public-references.js";

export type LoadStudioWorkflowCatalogOptions = {
  readonly workflowsRoot: string;
  readonly loadOptions: {
    readonly agentsRoot: string;
    readonly capabilityRegistry: CapabilityRegistry;
  };
};

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function errorCode(cause: unknown): string {
  const code = (cause as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0
    ? code
    : "workflow_catalog_entry_invalid";
}

function diagnostic(
  workflowId: string,
  cause: unknown
): StudioCatalogDiagnostic {
  const code = errorCode(cause);
  return StudioCatalogDiagnosticSchema.parse({
    severity: "error",
    code,
    message: `Workflow ${workflowId} could not be loaded (${code}).`,
    resource_kind: "workflow",
    resource_id: workflowId
  });
}

async function assertPhysicalDirectory(
  workflowsRoot: string,
  workflowId: string
): Promise<void> {
  assertSafeSegment(workflowId);
  const stats = await lstat(path.join(workflowsRoot, workflowId));
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw codedError(
      "workflow_catalog_entry_not_directory",
      `Workflow catalog entry is not a physical directory: ${workflowId}`
    );
  }
}

function summarizeWorkflow(
  definition: WorkflowDefinition
): StudioWorkflowSummary {
  const nodeCounts = {
    built_in: 0,
    agent: 0,
    pattern: 0,
    human_gate: 0
  };
  for (const node of definition.graph.nodes) {
    nodeCounts[node.type] += 1;
  }

  return StudioWorkflowSummarySchema.parse({
    id: definition.id,
    mode: definition.mode,
    revision: definition.revision,
    capabilities: definition.capabilities,
    input_schema: relativeCatalogFileReference(
      definition.directory,
      definition.input_schema,
      `workflow ${definition.id} input schema`
    ),
    output_schema: relativeCatalogFileReference(
      definition.directory,
      definition.output_schema,
      `workflow ${definition.id} output schema`
    ),
    ...(definition.config === undefined
      ? {}
      : {
          config: {
            file: relativeCatalogFileReference(
              definition.directory,
              definition.config.file,
              `workflow ${definition.id} config file`
            ),
            schema: relativeCatalogFileReference(
              definition.directory,
              definition.config.schema,
              `workflow ${definition.id} config schema`
            )
          }
        }),
    node_counts: nodeCounts,
    requires_repository: definition.requires.repository,
    max_concurrency: definition.execution.max_concurrency
  });
}

async function loadWorkflowSummary(
  options: LoadStudioWorkflowCatalogOptions,
  workflowId: string
): Promise<StudioWorkflowSummary> {
  await assertPhysicalDirectory(options.workflowsRoot, workflowId);
  return summarizeWorkflow(
    await loadWorkflowDefinitionWithAgentDigests(
      options.workflowsRoot,
      workflowId,
      options.loadOptions
    )
  );
}

export async function loadStudioWorkflowCatalog(
  options: LoadStudioWorkflowCatalogOptions
): Promise<StudioWorkflowCatalog> {
  const entries = await readdir(options.workflowsRoot, {
    withFileTypes: true
  }).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw cause;
  });
  const workflowIds = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const workflows: StudioWorkflowSummary[] = [];
  const diagnostics: StudioCatalogDiagnostic[] = [];

  for (const workflowId of workflowIds) {
    try {
      workflows.push(
        await loadWorkflowSummary(
          options,
          workflowId
        )
      );
    } catch (cause) {
      diagnostics.push(
        diagnostic(workflowId, cause)
      );
    }
  }

  return StudioWorkflowCatalogSchema.parse({
    status: diagnostics.length === 0 ? "complete" : "partial",
    fingerprint: sha256Digest({ workflows, diagnostics }),
    workflows,
    diagnostics
  });
}
