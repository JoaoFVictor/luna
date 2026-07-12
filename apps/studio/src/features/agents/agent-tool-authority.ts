import type { CapabilityCatalog, CapabilityRegistration, StudioMode } from "@/api/types"

export type AgentToolRegistration = Extract<
  CapabilityRegistration,
  { registration_kind: "tool" }
>

export function localAgentTools(
  catalog: CapabilityCatalog | undefined,
): readonly AgentToolRegistration[] {
  return (catalog?.registrations ?? []).filter(
    (registration): registration is AgentToolRegistration =>
      registration.registration_kind === "tool" && registration.protocol === "local",
  )
}

export function agentToolAllowed(
  tool: AgentToolRegistration,
  mode: StudioMode,
): boolean {
  return tool.allowed_agent_modes?.includes(mode) ?? false
}
