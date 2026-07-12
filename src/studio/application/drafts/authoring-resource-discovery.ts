import YAML from "yaml";
import { AgentMetadataSchema } from "../../../capabilities/agents/agent-definition.js";
import { isNamespacedCapabilityId } from "../../../core/capabilities/ids.js";
import { WorkflowDefinitionError } from "../../../core/workflow/definition-errors.js";
import { readWorkflowDefinitionReferences } from "../../../core/workflow/definition-references.js";
import {
  StudioPathSchema,
  StudioResourceRefSchema,
  type StudioPath
} from "../../contracts/paths.js";
import {
  isStudioEditableResource,
  type StudioEditableResource
} from "./authoring-resource-paths.js";

export type StudioWorkflowAgentReference = {
  readonly resource: StudioEditableResource;
  readonly outputSchema?: string;
};

export type StudioWorkflowResourceReferences = {
  readonly editable: readonly string[];
  readonly agents: readonly StudioWorkflowAgentReference[];
  readonly workflows: readonly StudioEditableResource[];
  readonly configDependency?: StudioPath;
  readonly canonical: boolean;
};

export type StudioAgentResourceReferences = {
  readonly editable: readonly string[];
  readonly canonical: boolean;
};

const DEFAULT_WORKFLOW_EDITABLE = [
  "input.schema.json",
  "output.schema.json"
] as const;
const DEFAULT_AGENT_EDITABLE = [
  "instructions.md",
  "output.schema.json"
] as const;

function editableAgentResource(agentId: string): StudioEditableResource | undefined {
  const parsed = StudioResourceRefSchema.safeParse({
    kind: "agent",
    id: agentId
  });
  return parsed.success && isStudioEditableResource(parsed.data)
    ? parsed.data
    : undefined;
}

function editableWorkflowResource(workflowId: string): StudioEditableResource | undefined {
  const parsed = StudioResourceRefSchema.safeParse({
    kind: "workflow",
    id: workflowId
  });
  return parsed.success && isStudioEditableResource(parsed.data)
    ? parsed.data
    : undefined;
}

function configDependency(file: string | undefined): StudioPath | undefined {
  if (file === undefined) {
    return undefined;
  }
  const parsed = StudioPathSchema.safeParse({ root: "config", path: file });
  return parsed.success ? parsed.data : undefined;
}

export function discoverStudioWorkflowResources(
  source: string
): StudioWorkflowResourceReferences {
  try {
    const references = readWorkflowDefinitionReferences(source);
    const dependency = configDependency(references.config?.file);
    const agents: StudioWorkflowAgentReference[] = [];
    for (const reference of references.agents) {
      const resource = editableAgentResource(reference.agentId);
      if (resource !== undefined) {
        agents.push({
          resource,
          ...(reference.outputSchema === undefined
            ? {}
            : { outputSchema: reference.outputSchema })
        });
      }
    }
    return {
      editable: [
        references.inputSchema,
        references.outputSchema,
        ...(references.config === undefined ? [] : [references.config.schema])
      ],
      agents,
      workflows: references.workflows.flatMap((workflowId) => {
        const resource = editableWorkflowResource(workflowId);
        return resource === undefined ? [] : [resource];
      }),
      ...(dependency === undefined ? {} : { configDependency: dependency }),
      canonical: true
    };
  } catch (cause) {
    if (!(cause instanceof WorkflowDefinitionError)) {
      throw cause;
    }
    return {
      editable: DEFAULT_WORKFLOW_EDITABLE,
      agents: [],
      workflows: [],
      canonical: false
    };
  }
}

export function discoverStudioAgentResources(
  source: string
): StudioAgentResourceReferences {
  let parsedYaml: unknown;
  try {
    parsedYaml = YAML.parse(source);
  } catch {
    return { editable: DEFAULT_AGENT_EDITABLE, canonical: false };
  }
  const parsed = AgentMetadataSchema.safeParse(parsedYaml);
  if (!parsed.success) {
    return { editable: DEFAULT_AGENT_EDITABLE, canonical: false };
  }
  const outputIsCapabilitySchema =
    isNamespacedCapabilityId(parsed.data.output_schema) &&
    !parsed.data.output_schema.endsWith(".json");
  return {
    editable: [
      parsed.data.instructions_file,
      ...(outputIsCapabilitySchema ? [] : [parsed.data.output_schema])
    ],
    canonical: true
  };
}
