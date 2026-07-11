import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadAgentDefinition
} from "../../../capabilities/agents/agent-loader.js";
import type {
  LoadedAgentDefinition
} from "../../../capabilities/agents/agent-definition.js";
import { agentDefinitionRevision } from "../../../capabilities/agents/agent-revision.js";
import type { CapabilityRegistry } from "../../../core/capabilities/registry.js";
import { isInsideRoot } from "../../../core/security/path.js";
import { StudioDraftAuthoringError } from "../../application/drafts/authoring-errors.js";
import {
  StudioAgentTestError,
  studioAgentTestError
} from "../../application/agents/test-bench-errors.js";
import type { StudioDraftItem } from "../../contracts/draft-authoring.js";
import type {
  StudioAgentTestTarget,
  StudioAgentTestTargetSnapshot
} from "../../contracts/agent-test-bench.js";

export interface NativeStudioAgentTestDraftPort {
  get(draftId: string): Promise<StudioDraftItem>;
}

export type NativeStudioAgentTestLoadedTarget = {
  readonly definition: LoadedAgentDefinition;
  readonly snapshot: StudioAgentTestTargetSnapshot;
};

export type LoadNativeStudioAgentTestTargetOptions = {
  readonly projectRoot: string;
  readonly target: StudioAgentTestTarget;
  readonly capabilityRegistry: Pick<CapabilityRegistry, "registrations">;
  readonly drafts: NativeStudioAgentTestDraftPort;
  readonly temporaryRoot?: string;
};

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" &&
    cause !== null &&
    typeof (cause as { readonly code?: unknown }).code === "string"
    ? (cause as { readonly code: string }).code
    : undefined;
}

function targetLoadError(cause: unknown, kind: StudioAgentTestTarget["kind"]): never {
  if (
    (kind === "installed" && errorCode(cause) === "ENOENT") ||
    (cause instanceof StudioDraftAuthoringError &&
      cause.code === "studio_draft_authoring_not_found")
  ) {
    throw studioAgentTestError(
      "studio_agent_test_target_not_found",
      "The requested agent test target does not exist",
      {},
      { cause }
    );
  }
  throw studioAgentTestError(
    "studio_agent_test_target_invalid",
    "The requested agent test target cannot be loaded safely",
    {},
    { cause }
  );
}

async function loadInstalledTarget(
  options: LoadNativeStudioAgentTestTargetOptions & {
    readonly target: Extract<StudioAgentTestTarget, { readonly kind: "installed" }>;
  }
): Promise<NativeStudioAgentTestLoadedTarget> {
  const definition = await loadAgentDefinition(
    path.join(options.projectRoot, "agents"),
    options.target.agent_id,
    { capabilityRegistry: options.capabilityRegistry }
  );
  const revision = agentDefinitionRevision(definition);
  if (revision !== options.target.revision) {
    throw studioAgentTestError(
      "studio_agent_test_target_stale",
      "The installed agent changed after it was selected",
      {
        agent_id: definition.id,
        requested_revision: options.target.revision,
        actual_revision: revision
      }
    );
  }
  return {
    definition,
    snapshot: {
      kind: "installed",
      agent_id: definition.id,
      agent_revision: revision,
      requested_revision: options.target.revision
    }
  };
}

function assertDraftFileTarget(
  root: string,
  agentDirectory: string,
  item: StudioDraftItem["files"][number]
): string {
  if (
    item.file.root !== "project" ||
    !item.file.path.startsWith(`${agentDirectory}/`)
  ) {
    throw studioAgentTestError(
      "studio_agent_test_target_invalid",
      "The saved agent draft contains a file outside its resource directory",
      { file: item.file }
    );
  }
  const target = path.resolve(root, ...item.file.path.split("/"));
  if (!isInsideRoot(root, target)) {
    throw studioAgentTestError(
      "studio_agent_test_target_invalid",
      "The saved agent draft contains an unsafe file path",
      { file: item.file }
    );
  }
  return target;
}

async function loadDraftDefinition(
  draft: StudioDraftItem,
  capabilityRegistry: Pick<CapabilityRegistry, "registrations">,
  temporaryRoot: string | undefined
): Promise<LoadedAgentDefinition> {
  const root = await mkdtemp(path.join(
    temporaryRoot ?? tmpdir(),
    "luna-studio-agent-test-"
  ));
  const agentDirectory = `agents/${draft.primary_resource.id}`;
  const seen = new Set<string>();
  try {
    await mkdir(path.join(root, "agents"), {
      recursive: true,
      mode: 0o700
    });
    for (const item of draft.files) {
      const target = assertDraftFileTarget(root, agentDirectory, item);
      if (seen.has(target)) {
        throw studioAgentTestError(
          "studio_agent_test_target_invalid",
          "The saved agent draft contains duplicate file paths",
          { file: item.file }
        );
      }
      seen.add(target);
      if (item.state === "deleted") {
        continue;
      }
      if (item.content === undefined) {
        throw studioAgentTestError(
          "studio_agent_test_target_invalid",
          "The saved agent draft is missing present file content",
          { file: item.file }
        );
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, item.content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
    }
    return await loadAgentDefinition(
      path.join(root, "agents"),
      draft.primary_resource.id,
      { capabilityRegistry }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function loadDraftTarget(
  options: LoadNativeStudioAgentTestTargetOptions & {
    readonly target: Extract<StudioAgentTestTarget, { readonly kind: "draft" }>;
  }
): Promise<NativeStudioAgentTestLoadedTarget> {
  const draft = await options.drafts.get(options.target.draft_id);
  if (draft.etag !== options.target.etag) {
    throw studioAgentTestError(
      "studio_agent_test_target_stale",
      "The saved agent draft changed after it was selected",
      {
        draft_id: draft.draft_id,
        requested_etag: options.target.etag,
        actual_etag: draft.etag
      }
    );
  }
  if (draft.primary_resource.kind !== "agent") {
    throw studioAgentTestError(
      "studio_agent_test_target_invalid",
      "Agent smoke tests require an agent draft",
      {
        draft_id: draft.draft_id,
        resource_kind: draft.primary_resource.kind
      }
    );
  }
  const definition = await loadDraftDefinition(
    draft,
    options.capabilityRegistry,
    options.temporaryRoot
  );
  const revision = agentDefinitionRevision(definition);
  return {
    definition,
    snapshot: {
      kind: "draft",
      agent_id: definition.id,
      agent_revision: revision,
      draft_id: draft.draft_id,
      etag: draft.etag,
      record_revision: draft.record_revision,
      content_revision: draft.content_revision
    }
  };
}

export async function loadNativeStudioAgentTestTarget(
  options: LoadNativeStudioAgentTestTargetOptions
): Promise<NativeStudioAgentTestLoadedTarget> {
  try {
    return options.target.kind === "installed"
      ? await loadInstalledTarget({ ...options, target: options.target })
      : await loadDraftTarget({ ...options, target: options.target });
  } catch (cause) {
    if (cause instanceof StudioAgentTestError) {
      throw cause;
    }
    targetLoadError(cause, options.target.kind);
  }
}
