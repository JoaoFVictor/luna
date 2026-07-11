import {
  StudioRelativePathSchema,
  type StudioPath,
  type StudioResourceRef
} from "../../contracts/paths.js";

export type StudioEditableResource = StudioResourceRef & {
  readonly kind: "workflow" | "agent";
};

export function isStudioEditableResource(
  resource: StudioResourceRef
): resource is StudioEditableResource {
  return resource.kind === "workflow" || resource.kind === "agent";
}

export function studioEditableResourceDirectory(
  resource: StudioEditableResource
): string {
  return resource.kind === "workflow"
    ? `workflows/${resource.id}`
    : `agents/${resource.id}`;
}

export function studioEditableResourceFile(
  resource: StudioEditableResource,
  relativePath: string
): StudioPath | undefined {
  const parsed = StudioRelativePathSchema.safeParse(relativePath);
  return parsed.success
    ? {
        root: "project",
        path: `${studioEditableResourceDirectory(resource)}/${parsed.data}`
      }
    : undefined;
}

export function studioEditableDefinitionFile(
  resource: StudioEditableResource
): StudioPath {
  return {
    root: "project",
    path: `${studioEditableResourceDirectory(resource)}/${
      resource.kind === "workflow" ? "workflow.yaml" : "agent.yaml"
    }`
  };
}

export function isStudioEditableResourcePath(
  resource: StudioEditableResource,
  file: StudioPath
): boolean {
  return (
    file.root === "project" &&
    file.path.startsWith(`${studioEditableResourceDirectory(resource)}/`)
);
}
