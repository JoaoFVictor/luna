import type { JsonValue } from "@/api/types"
import type { WorkflowSideEffectPreview } from "@/features/workflows/workflow-side-effect-preview"

export function agentSideEffectPreview(
  source: JsonValue | undefined,
  agentId: string,
): readonly WorkflowSideEffectPreview[] {
  if (
    source === undefined ||
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) {
    return [{
      nodeId: agentId,
      source: "agent_tools",
      semantics: "unknown",
      description: "A projeção estruturada do agent está indisponível; revise os arquivos antes do apply.",
      operationIds: [],
    }]
  }
  const collections = [source.tools, source.mcp_servers, source.subagents]
  const trustedLocalWrite = source.mode === "trusted_local_write"
  return trustedLocalWrite ||
    collections.some((value) => Array.isArray(value) && value.length > 0)
    ? [{
        nodeId: agentId,
        source: "agent_tools",
        semantics: "unknown",
        description: trustedLocalWrite
          ? "O agent opera em trusted_local_write; escritas locais e efeitos do runtime devem ser confirmados no plano."
          : "O agent declara tools, MCP ou subagents; efeitos dependem do runtime e da invocation.",
        operationIds: [],
      }]
    : []
}
