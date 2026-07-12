import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import type {
  StudioBaseFile,
  StudioDependency,
  StudioDraftFileChange
} from "../../contracts/drafts.js";
import {
  STUDIO_DRAFT_AUTHORING_LIMITS,
  type StudioDraftCreateRequest
} from "../../contracts/draft-authoring.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import {
  studioPathKey,
  type StudioPath,
  type StudioResourceRef
} from "../../contracts/paths.js";
import type { StudioDraftBlob } from "./persistence.js";
import { StudioDraftAuthoringError } from "./authoring-errors.js";
import { studioAuthoringContentDigest } from "./authoring-digests.js";
import type {
  StudioAuthoringSourceFile,
  StudioAuthoringSourcePort,
  StudioResourceRevisionPort
} from "./authoring-ports.js";
import {
  isStudioEditableResource,
  studioEditableDefinitionFile,
  studioEditableResourceFile,
  type StudioEditableResource
} from "./authoring-resource-paths.js";
import {
  blankStudioResourceSources,
  templateStudioResourceSources,
  type StudioTemplateResourceSource
} from "./authoring-templates.js";
import {
  discoverStudioAgentResources,
  discoverStudioWorkflowResources,
  type StudioWorkflowAgentReference
} from "./authoring-resource-discovery.js";

const MAX_SOURCE_FILE_BYTES = STUDIO_DRAFT_AUTHORING_LIMITS.maxContentBytes;
const MAX_BUNDLE_BYTES = STUDIO_DRAFT_AUTHORING_LIMITS.maxProjectionBytes;
const MAX_BUNDLE_FILES = 128;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MODELS_CONFIG_FILE = {
  root: "config",
  path: "models.yaml"
} as const satisfies StudioPath;

type ReadStudioFile = {
  readonly file: StudioPath;
  readonly content: string;
  readonly sha256: string;
  readonly mode: number;
};

export type StudioDraftBundle = {
  readonly resourceRevision: string | null;
  readonly baseBundleHash: string | null;
  readonly baseFiles: readonly StudioBaseFile[];
  readonly dependencies: readonly StudioDependency[];
  readonly allowedFiles: readonly StudioPath[];
  readonly changes: readonly StudioDraftFileChange[];
  readonly blobs: readonly StudioDraftBlob[];
};

export type BuildStudioDraftBundleOptions = {
  readonly source: StudioAuthoringSourcePort;
  readonly revisions: StudioResourceRevisionPort;
};

export function computeStudioBaseBundleHash(
  baseFiles: readonly StudioBaseFile[],
  dependencies: readonly StudioDependency[]
): string {
  return sha256Digest({
    base_files: baseFiles.map(({ file, sha256, mode }) => ({
      file,
      sha256,
      mode
    })),
    dependencies
  });
}

class SourceBudget {
  private bytes = 0;
  private files = 0;

  account(file: StudioPath, bytes: number): void {
    this.bytes += bytes;
    this.files += 1;
    if (this.bytes > MAX_BUNDLE_BYTES || this.files > MAX_BUNDLE_FILES) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_source_too_large",
        "The Studio resource bundle exceeds its authoring limit",
        {
          details: {
            file,
            actualBytes: this.bytes,
            maxBytes: MAX_BUNDLE_BYTES
          }
        }
      );
    }
  }
}

async function readSourceFile(
  source: StudioAuthoringSourcePort,
  file: StudioPath,
  budget: SourceBudget
): Promise<ReadStudioFile | undefined> {
  let loaded: StudioAuthoringSourceFile | undefined;
  try {
    loaded = await source.read(file, { maxBytes: MAX_SOURCE_FILE_BYTES });
  } catch (cause) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_source_invalid",
      "The Studio resource source could not be read safely",
      { cause, details: { file } }
    );
  }
  if (loaded === undefined) {
    return undefined;
  }
  budget.account(file, loaded.content.byteLength);
  const digest = studioAuthoringContentDigest(loaded.content);
  if (
    digest !== loaded.sha256 ||
    !StudioDigestSchema.safeParse(loaded.sha256).success ||
    !Number.isInteger(loaded.mode) ||
    loaded.mode < 0 ||
    loaded.mode > 0o777
  ) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_source_invalid",
      "The Studio resource source returned invalid file metadata",
      { details: { file } }
    );
  }
  let content: string;
  try {
    content = UTF8_DECODER.decode(loaded.content);
  } catch (cause) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_source_invalid",
      "Studio authoring supports UTF-8 text resources only",
      { cause, details: { file } }
    );
  }
  return { file, content, sha256: digest, mode: loaded.mode };
}

async function addDependencyIfPresent(
  dependencies: Map<string, ReadStudioFile>,
  editable: ReadonlySet<string>,
  source: StudioAuthoringSourcePort,
  file: StudioPath | undefined,
  budget: SourceBudget
): Promise<void> {
  if (
    file === undefined ||
    editable.has(studioPathKey(file)) ||
    dependencies.has(studioPathKey(file))
  ) {
    return;
  }
  const loaded = await readSourceFile(source, file, budget);
  if (loaded !== undefined) {
    dependencies.set(studioPathKey(file), loaded);
  }
}

async function collectAgentDependencies(
  reference: StudioWorkflowAgentReference,
  source: StudioAuthoringSourcePort,
  budget: SourceBudget,
  editable: ReadonlySet<string>,
  dependencies: Map<string, ReadStudioFile>
): Promise<void> {
  const agentDefinition = studioEditableDefinitionFile(reference.resource);
  if (dependencies.has(studioPathKey(agentDefinition))) {
    if (reference.outputSchema !== undefined) {
      await addDependencyIfPresent(
        dependencies,
        editable,
        source,
        studioEditableResourceFile(reference.resource, reference.outputSchema),
        budget
      );
    }
    return;
  }
  const loadedDefinition = await readSourceFile(source, agentDefinition, budget);
  if (loadedDefinition === undefined) {
    return;
  }
  dependencies.set(studioPathKey(agentDefinition), loadedDefinition);
  const references = new Set(
    discoverStudioAgentResources(loadedDefinition.content).editable
  );
  if (reference.outputSchema !== undefined) {
    references.add(reference.outputSchema);
  }
  for (const relativePath of references) {
    await addDependencyIfPresent(
      dependencies,
      editable,
      source,
      studioEditableResourceFile(reference.resource, relativePath),
      budget
    );
  }
}

async function collectWorkflowDependencies(
  resource: StudioEditableResource,
  source: StudioAuthoringSourcePort,
  budget: SourceBudget,
  editable: ReadonlySet<string>,
  dependencies: Map<string, ReadStudioFile>,
  visiting: ReadonlySet<string> = new Set()
): Promise<void> {
  const definitionFile = studioEditableDefinitionFile(resource);
  const definitionKey = studioPathKey(definitionFile);
  if (editable.has(definitionKey) || visiting.has(definitionKey)) return;

  let definition = dependencies.get(definitionKey);
  if (definition === undefined) {
    definition = await readSourceFile(source, definitionFile, budget);
    if (definition === undefined) return;
    dependencies.set(definitionKey, definition);
  }

  const references = discoverStudioWorkflowResources(definition.content);
  for (const relativePath of references.editable) {
    await addDependencyIfPresent(
      dependencies,
      editable,
      source,
      studioEditableResourceFile(resource, relativePath),
      budget
    );
  }
  for (const agent of references.agents) {
    await collectAgentDependencies(agent, source, budget, editable, dependencies);
  }
  await addDependencyIfPresent(
    dependencies,
    editable,
    source,
    references.configDependency,
    budget
  );
  if (references.agents.length > 0) {
    await addDependencyIfPresent(
      dependencies,
      editable,
      source,
      MODELS_CONFIG_FILE,
      budget
    );
  }

  const nestedVisiting = new Set(visiting);
  nestedVisiting.add(definitionKey);
  for (const child of references.workflows) {
    await collectWorkflowDependencies(
      child,
      source,
      budget,
      editable,
      dependencies,
      nestedVisiting
    );
  }
}

async function existingBundle(
  options: BuildStudioDraftBundleOptions,
  resource: StudioEditableResource
): Promise<StudioDraftBundle> {
  const budget = new SourceBudget();
  const primaryDefinition = studioEditableDefinitionFile(resource);
  const loadedDefinition = await readSourceFile(
    options.source,
    primaryDefinition,
    budget
  );
  if (loadedDefinition === undefined) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_resource_not_found",
      "The requested Studio resource does not exist"
    );
  }
  const discovered =
    resource.kind === "workflow"
      ? discoverStudioWorkflowResources(loadedDefinition.content)
      : discoverStudioAgentResources(loadedDefinition.content);
  const editableReferences = discovered.editable;
  const editablePaths = new Map<string, StudioPath>([
    [studioPathKey(primaryDefinition), primaryDefinition]
  ]);
  for (const relativePath of editableReferences) {
    const file = studioEditableResourceFile(resource, relativePath);
    if (file !== undefined) {
      editablePaths.set(studioPathKey(file), file);
    }
  }

  const editableFiles = new Map<string, ReadStudioFile>();
  editableFiles.set(studioPathKey(primaryDefinition), loadedDefinition);
  for (const [key, file] of editablePaths) {
    if (key === studioPathKey(primaryDefinition)) {
      continue;
    }
    const loaded = await readSourceFile(options.source, file, budget);
    if (loaded !== undefined) {
      editableFiles.set(key, loaded);
    }
  }

  const editable = new Set(editablePaths.keys());
  const dependencies = new Map<string, ReadStudioFile>();
  if (resource.kind === "workflow") {
    const workflowReferences = discoverStudioWorkflowResources(
      loadedDefinition.content
    );
    for (const agent of workflowReferences.agents) {
      await collectAgentDependencies(
        agent,
        options.source,
        budget,
        editable,
        dependencies
      );
    }
    for (const child of workflowReferences.workflows) {
      await collectWorkflowDependencies(
        child,
        options.source,
        budget,
        editable,
        dependencies
      );
    }
    await addDependencyIfPresent(
      dependencies,
      editable,
      options.source,
      workflowReferences.configDependency,
      budget
    );
    if (workflowReferences.agents.length > 0) {
      await addDependencyIfPresent(
        dependencies,
        editable,
        options.source,
        MODELS_CONFIG_FILE,
        budget
      );
    }
  } else {
    await addDependencyIfPresent(
      dependencies,
      editable,
      options.source,
      MODELS_CONFIG_FILE,
      budget
    );
  }

  const orderedPaths = [...editablePaths.values()].sort((left, right) =>
    studioPathKey(left).localeCompare(studioPathKey(right))
  );
  const baseFiles: StudioBaseFile[] = orderedPaths.map((file) => {
    const loaded = editableFiles.get(studioPathKey(file));
    return loaded === undefined
      ? { file, sha256: null, content_ref: null, mode: null }
      : {
          file,
          sha256: loaded.sha256,
          content_ref: loaded.sha256,
          mode: loaded.mode
        };
  });
  const orderedDependencies: StudioDependency[] = [...dependencies.values()]
    .sort((left, right) =>
      studioPathKey(left.file).localeCompare(studioPathKey(right.file))
    )
    .map((dependency) => ({
      file: dependency.file,
      sha256: dependency.sha256
    }));
  const blobs = new Map<string, StudioDraftBlob>();
  for (const file of editableFiles.values()) {
    blobs.set(file.sha256, { digest: file.sha256, content: file.content });
  }
  const resourceRevision = await options.revisions.current(resource);
  if (
    resourceRevision !== null &&
    !StudioDigestSchema.safeParse(resourceRevision).success
  ) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_source_invalid",
      "The Studio resource revision is invalid"
    );
  }
  return {
    resourceRevision,
    baseBundleHash: computeStudioBaseBundleHash(
      baseFiles,
      orderedDependencies
    ),
    baseFiles,
    dependencies: orderedDependencies,
    allowedFiles: orderedPaths,
    changes: [],
    blobs: [...blobs.values()]
  };
}

async function generatedBundle(
  options: BuildStudioDraftBundleOptions,
  resource: StudioEditableResource,
  sources: readonly StudioTemplateResourceSource[]
): Promise<StudioDraftBundle> {
  const budget = new SourceBudget();
  for (const source of sources) {
    if ((await readSourceFile(options.source, source.file, budget)) !== undefined) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_resource_invalid",
        "A generated Studio resource cannot replace an existing file"
      );
    }
  }
  const baseFiles: StudioBaseFile[] = [];
  const changes: StudioDraftFileChange[] = [];
  const blobs = new Map<string, StudioDraftBlob>();
  for (const source of sources) {
    const digest = studioAuthoringContentDigest(Buffer.from(source.content, "utf8"));
    baseFiles.push({
      file: source.file,
      sha256: null,
      content_ref: null,
      mode: null
    });
    changes.push({
      action: "write",
      file: source.file,
      base_sha256: null,
      content_sha256: digest,
      content_ref: digest,
      mode: 0o644
    });
    blobs.set(digest, { digest, content: source.content });
  }
  const editable = new Set(sources.map((source) => studioPathKey(source.file)));
  const dependencies = new Map<string, ReadStudioFile>();
  if (resource.kind === "workflow") {
    const definitionFile = studioEditableDefinitionFile(resource);
    const definition = sources.find(
      (source) => studioPathKey(source.file) === studioPathKey(definitionFile)
    );
    if (definition === undefined) {
      throw new StudioDraftAuthoringError(
        "studio_draft_authoring_resource_invalid",
        "A generated workflow must include its canonical definition"
      );
    }
    const references = discoverStudioWorkflowResources(definition.content);
    for (const agent of references.agents) {
      await collectAgentDependencies(
        agent,
        options.source,
        budget,
        editable,
        dependencies
      );
      if (
        !dependencies.has(
          studioPathKey(studioEditableDefinitionFile(agent.resource))
        )
      ) {
        throw new StudioDraftAuthoringError(
          "studio_draft_authoring_resource_invalid",
          `The selected Studio template agent does not exist: ${agent.resource.id}`
        );
      }
    }
    for (const child of references.workflows) {
      await collectWorkflowDependencies(
        child,
        options.source,
        budget,
        editable,
        dependencies
      );
      if (
        !dependencies.has(
          studioPathKey(studioEditableDefinitionFile(child))
        )
      ) {
        throw new StudioDraftAuthoringError(
          "studio_draft_authoring_resource_invalid",
          `The selected Studio template workflow does not exist: ${child.id}`
        );
      }
    }
    await addDependencyIfPresent(
      dependencies,
      editable,
      options.source,
      references.configDependency,
      budget
    );
    if (references.agents.length > 0) {
      await addDependencyIfPresent(
        dependencies,
        editable,
        options.source,
        MODELS_CONFIG_FILE,
        budget
      );
    }
  } else {
    await addDependencyIfPresent(
      dependencies,
      editable,
      options.source,
      MODELS_CONFIG_FILE,
      budget
    );
  }
  const orderedDependencies: StudioDependency[] = [...dependencies.values()]
    .sort((left, right) =>
      studioPathKey(left.file).localeCompare(studioPathKey(right.file))
    )
    .map((dependency) => ({
      file: dependency.file,
      sha256: dependency.sha256
    }));
  return {
    resourceRevision: null,
    baseBundleHash: null,
    baseFiles,
    dependencies: orderedDependencies,
    allowedFiles: sources.map((source) => source.file),
    changes,
    blobs: [...blobs.values()]
  };
}

export async function buildStudioDraftBundle(
  options: BuildStudioDraftBundleOptions,
  resource: StudioResourceRef,
  source: StudioDraftCreateRequest["source"]
): Promise<StudioDraftBundle> {
  if (!isStudioEditableResource(resource)) {
    throw new StudioDraftAuthoringError(
      "studio_draft_authoring_resource_invalid",
      "Studio authoring supports workflow and agent resources"
    );
  }
  if (source.mode === "existing") {
    return await existingBundle(options, resource);
  }
  const sources =
    source.mode === "blank"
      ? blankStudioResourceSources(
          resource,
          "model_profile" in source ? source.model_profile : undefined
        )
      : templateStudioResourceSources(resource, source);
  return await generatedBundle(options, resource, sources);
}
