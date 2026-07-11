import { StudioDigestSchema } from "../../contracts/digests.js";
import {
  studioPathKey,
  type StudioResourceRef
} from "../../contracts/paths.js";
import {
  buildStudioDraftBundle,
  computeStudioBaseBundleHash,
  type StudioDraftBundle
} from "../drafts/authoring-bundles.js";
import { mergeStudioDraftBlobs } from "../drafts/authoring-blobs.js";
import type {
  StudioAuthoringSourcePort,
  StudioResourceRevisionPort
} from "../drafts/authoring-ports.js";
import type { StudioWorkflowConfigurationSource } from "./source.js";
import { StudioConfigurationError } from "./errors.js";

export async function buildStudioConfigurationDraftBundle(input: {
  readonly source: StudioAuthoringSourcePort;
  readonly revisions: StudioResourceRevisionPort;
  readonly configuration: StudioWorkflowConfigurationSource;
}): Promise<StudioDraftBundle> {
  const { configuration } = input;
  if (
    !configuration.declared ||
    configuration.schemaFile === undefined ||
    configuration.configFile === undefined ||
    configuration.schema === undefined ||
    !configuration.schemaValid
  ) {
    throw new StudioConfigurationError(
      "studio_configuration_schema_unavailable",
      "Workflow configuration requires a present valid JSON Schema"
    );
  }
  const workflowResource = {
    kind: "workflow" as const,
    id: configuration.workflowId
  };
  const workflow = await buildStudioDraftBundle(
    { source: input.source, revisions: input.revisions },
    workflowResource,
    { mode: "existing" }
  );
  const configKey = studioPathKey(configuration.configFile.file);
  const baseFiles = [
    ...workflow.baseFiles,
    {
      file: configuration.configFile.file,
      sha256: configuration.configFile.sha256,
      content_ref: configuration.configFile.sha256,
      mode: configuration.configFile.mode
    }
  ].sort((left, right) =>
    studioPathKey(left.file).localeCompare(studioPathKey(right.file))
  );
  const dependencies = workflow.dependencies
    .filter((dependency) => studioPathKey(dependency.file) !== configKey)
    .sort((left, right) =>
      studioPathKey(left.file).localeCompare(studioPathKey(right.file))
    );
  const resource: StudioResourceRef = {
    kind: "config",
    id: configuration.workflowId
  };
  const resourceRevision = await input.revisions.current(resource);
  if (
    resourceRevision !== null &&
    !StudioDigestSchema.safeParse(resourceRevision).success
  ) {
    throw new StudioConfigurationError(
      "studio_configuration_source_invalid",
      "The installed workflow configuration revision is invalid"
    );
  }
  return {
    resourceRevision,
    baseBundleHash: computeStudioBaseBundleHash(baseFiles, dependencies),
    baseFiles,
    dependencies,
    allowedFiles: baseFiles.map((base) => base.file),
    changes: [],
    blobs: mergeStudioDraftBlobs(workflow.blobs, [
      {
        digest: configuration.configFile.sha256,
        content: configuration.configFile.content
      }
    ])
  };
}
