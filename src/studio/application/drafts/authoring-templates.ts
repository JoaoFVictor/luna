import YAML from "yaml";
import {
  StudioDraftTemplateCatalogSchema,
  type StudioDraftTemplateCatalog,
  type StudioDraftTemplateSelection
} from "../../contracts/draft-authoring.js";
import type { StudioPath } from "../../contracts/paths.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";
import { BUILT_IN_STUDIO_DRAFT_TEMPLATE_CATALOG } from "./authoring-template-catalog.js";
import { assertTemplateParameters } from "./authoring-template-parameters.js";
import { buildWorkflowTemplateDefinition } from "./authoring-template-workflows.js";
import {
  studioEditableDefinitionFile,
  studioEditableResourceFile,
  type StudioEditableResource
} from "./authoring-resource-paths.js";

export type StudioTemplateResourceSource = {
  readonly file: StudioPath;
  readonly content: string;
};

function blankJsonSchema(): string {
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false
    },
    null,
    2
  )}\n`;
}

function templateResourceFile(
  resource: StudioEditableResource,
  relativePath: string
): StudioPath {
  const file = studioEditableResourceFile(resource, relativePath);
  if (file === undefined) {
    throw new Error(`Invalid built-in Studio template path: ${relativePath}`);
  }
  return file;
}

export function blankStudioResourceSources(
  resource: StudioEditableResource,
  modelProfile?: string
): readonly StudioTemplateResourceSource[] {
  const jsonSchema = blankJsonSchema();
  if (resource.kind === "workflow") {
    return [
      {
        file: studioEditableDefinitionFile(resource),
        content: YAML.stringify({
          id: resource.id,
          type: "workflow",
          mode: "read_only",
          input_schema: "input.schema.json",
          output_schema: "output.schema.json",
          capabilities: [],
          nodes: []
        })
      },
      {
        file: templateResourceFile(resource, "input.schema.json"),
        content: jsonSchema
      },
      {
        file: templateResourceFile(resource, "output.schema.json"),
        content: jsonSchema
      }
    ];
  }
  if (modelProfile === undefined) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_model_profile_unavailable",
      "Blank agent creation requires an available model profile"
    );
  }
  return [
    {
      file: studioEditableDefinitionFile(resource),
      content: YAML.stringify({
        id: resource.id,
        description: `Agent ${resource.id}.`,
        model_profile: modelProfile,
        mode: "read_only",
        instructions_file: "instructions.md",
        output_schema: "output.schema.json"
      })
    },
    {
      file: templateResourceFile(resource, "instructions.md"),
      content: `# ${resource.id}\n\nDescribe this agent's responsibilities and constraints.\n`
    },
    {
      file: templateResourceFile(resource, "output.schema.json"),
      content: jsonSchema
    }
  ];
}

function workflowSources(
  resource: StudioEditableResource,
  workflow: unknown
): readonly StudioTemplateResourceSource[] {
  if (resource.kind !== "workflow") {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_resource_invalid",
      "The selected Studio template only creates workflow resources"
    );
  }
  const schema = blankJsonSchema();
  return [
    {
      file: studioEditableDefinitionFile(resource),
      content: YAML.stringify(workflow)
    },
    {
      file: templateResourceFile(resource, "input.schema.json"),
      content: schema
    },
    {
      file: templateResourceFile(resource, "output.schema.json"),
      content: schema
    }
  ];
}

export function studioDraftTemplateCatalog(): StudioDraftTemplateCatalog {
  return StudioDraftTemplateCatalogSchema.parse(
    BUILT_IN_STUDIO_DRAFT_TEMPLATE_CATALOG
  );
}

export function templateStudioResourceSources(
  resource: StudioEditableResource,
  selection: StudioDraftTemplateSelection
): readonly StudioTemplateResourceSource[] {
  const template = BUILT_IN_STUDIO_DRAFT_TEMPLATE_CATALOG.templates.find(
    (candidate) =>
      candidate.id === selection.template_id &&
      candidate.version === selection.template_version
  );
  if (template === undefined) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_resource_invalid",
      "The requested Studio template or version is not available"
    );
  }
  if (selection.template_id === "blank-workflow") {
    assertTemplateParameters(selection, []);
    if (resource.kind !== "workflow") {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_resource_invalid",
        "The selected Studio template only creates workflow resources"
      );
    }
    return blankStudioResourceSources(resource);
  }
  const workflow = buildWorkflowTemplateDefinition(
    resource.id,
    selection,
    template
  );
  if (workflow !== undefined) {
    return workflowSources(resource, workflow);
  }
  throw new StudioDraftAuthoringError(
    "studio_draft_authoring_resource_invalid",
    "The requested Studio template is not available"
  );
}
