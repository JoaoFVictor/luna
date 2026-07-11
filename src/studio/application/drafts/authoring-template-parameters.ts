import {
  StudioDraftTemplateAgentValueSchema,
  type StudioDraftTemplateCatalog,
  type StudioDraftTemplateSelection
} from "../../contracts/draft-authoring.js";
import { StudioCatalogReferenceSchema } from "../../contracts/catalog-references.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";

export type TemplateDescriptor = StudioDraftTemplateCatalog["templates"][number];

export type TemplateAgent = {
  readonly id: string;
  readonly outputSchema: string;
  readonly mode: "read_only" | "trusted_local_write";
};

export function assertTemplateParameters(
  selection: StudioDraftTemplateSelection,
  allowed: readonly string[]
): Readonly<Record<string, unknown>> {
  const parameters = selection.parameters ?? {};
  const unexpected = Object.keys(parameters).find(
    (parameter) => !allowed.includes(parameter)
  );
  if (unexpected !== undefined) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_resource_invalid",
      `Unsupported Studio template parameter: ${unexpected}`
    );
  }
  return parameters;
}

export function agentParameters(
  selection: StudioDraftTemplateSelection,
  template: TemplateDescriptor,
  parameterIds: readonly string[]
): Readonly<Record<string, TemplateAgent>> {
  const parameters = assertTemplateParameters(selection, parameterIds);
  const result: Record<string, TemplateAgent> = {};
  for (const parameterId of parameterIds) {
    const agent = StudioDraftTemplateAgentValueSchema.safeParse(
      parameters[parameterId]
    );
    const outputSchema = StudioCatalogReferenceSchema.safeParse(
      agent.success ? agent.data.output_schema : undefined
    );
    const descriptor = template.parameters.find(
      (parameter) => parameter.id === parameterId
    );
    if (!agent.success || !outputSchema.success || descriptor === undefined) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_resource_invalid",
        `${selection.template_id} requires a valid ${parameterId} agent, output schema, and compatible mode`
      );
    }
    const mode = agent.data.mode ?? "read_only";
    if (
      descriptor.allowed_modes !== undefined &&
      !descriptor.allowed_modes.includes(mode)
    ) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_resource_invalid",
        `${selection.template_id} requires a valid ${parameterId} agent, output schema, and compatible mode`
      );
    }
    result[parameterId] = {
      id: agent.data.id,
      outputSchema: outputSchema.data,
      mode
    };
  }
  return result;
}

export function requiredAgent(
  agents: Readonly<Record<string, TemplateAgent>>,
  parameterId: string
): TemplateAgent {
  const agent = agents[parameterId];
  if (agent === undefined) {
    throw new Error(`Validated Studio template agent is missing: ${parameterId}`);
  }
  return agent;
}

export function schemaCapabilities(
  agents: readonly TemplateAgent[]
): readonly string[] {
  return agents
    .flatMap((agent) =>
      agent.outputSchema.endsWith(".json")
        ? []
        : [agent.outputSchema.split(".", 1)[0] as string]
    )
    .filter((capability, index, all) => all.indexOf(capability) === index);
}

export function templateArtifact(
  path: string,
  expression: string,
  format: "json" | "markdown"
) {
  return {
    path,
    publisher: "artifacts.manifest_publisher",
    source: { expression },
    format
  };
}
