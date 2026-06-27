import { publishDeclaredArtifacts } from "../../capabilities/artifacts/publisher.js";
import type { LunaRuntimeState } from "../../core/runtime/state.js";
import type { CompiledWorkflowNode } from "../../core/workflow/compiler.js";
import type { RunCompiledWorkflowInput } from "./workflow-runner-types.js";

export async function publishArtifactsForNode(
  input: RunCompiledWorkflowInput,
  node: CompiledWorkflowNode,
  output: unknown,
  state: LunaRuntimeState
): Promise<LunaRuntimeState["artifact_refs"]> {
  const artifactPublisher = input.artifactPublisher;
  if (artifactPublisher === undefined || !nodeHasArtifacts(node)) {
    return [];
  }

  const published = await publishDeclaredArtifacts({
    publisher: artifactPublisher,
    node: node.source,
    output,
    state
  });

  return published.artifacts.map((artifact) => ({
    id: artifact.id,
    uri: artifact.uri,
    node_id: artifact.node_id
  }));
}

function nodeHasArtifacts(
  node: CompiledWorkflowNode
): node is CompiledWorkflowNode & {
  readonly source: Extract<
    CompiledWorkflowNode["source"],
    { readonly artifacts?: unknown }
  >;
} {
  return (
    (node.source.type === "built_in" ||
      node.source.type === "agent" ||
      node.source.type === "pattern" ||
      node.source.type === "human_gate") &&
    (node.source.artifacts?.length ?? 0) > 0
  );
}
