import type { CapabilityRegistry } from "../../core/capabilities/registry.js";
import { assertSafeSegment } from "../../core/security/path.js";
import type { DefinitionDigestResolver } from "../../core/workflow/definition-digests.js";
import { loadAgentDefinition } from "./agent-loader.js";
import { agentDefinitionRevision } from "./agent-revision.js";

export type AgentDefinitionDigestResolverOptions = {
  readonly agentsRoot: string;
  readonly capabilityRegistry: Pick<CapabilityRegistry, "registrations">;
};

function unsupportedReference(reference: string): Error & { code: string } {
  const error = new Error(
    `Unsupported agent external definition reference: ${reference}`
  ) as Error & { code: string };
  error.code = "agent_external_definition_reference_invalid";
  return error;
}

function agentIdFromReference(reference: string): string {
  const match = /^agents\/([^/]+)\/agent\.yaml$/.exec(reference);
  if (match?.[1] === undefined) {
    throw unsupportedReference(reference);
  }
  try {
    assertSafeSegment(match[1]);
  } catch {
    throw unsupportedReference(reference);
  }
  return match[1];
}

export function createAgentDefinitionDigestResolver(
  options: AgentDefinitionDigestResolverOptions
): DefinitionDigestResolver {
  return {
    async digestExternalDefinition(reference: string): Promise<string> {
      const agentId = agentIdFromReference(reference);
      const definition = await loadAgentDefinition(
        options.agentsRoot,
        agentId,
        { capabilityRegistry: options.capabilityRegistry }
      );
      return agentDefinitionRevision(definition);
    }
  };
}
