import { describe, expect, it } from "vitest"

import type { CapabilityCatalog } from "@/api/types"
import {
  agentToolAllowed,
  localAgentTools,
} from "@/features/agents/agent-tool-authority"

const catalog: CapabilityCatalog = {
  technical_fingerprint: `sha256:${"1".repeat(64)}`,
  presentation_fingerprint: `sha256:${"2".repeat(64)}`,
  capabilities: [],
  registrations: [
    {
      registration_kind: "tool",
      id: "repository.read-file",
      owner: {
        capability_id: "repository",
        capability_version: "1",
        capability_kind: "execution",
      },
      presentation: { title: "Read file" },
      protocol: "local",
      input_schema: {},
      output_schema: {},
      runtime_requirements: ["tool_calling"],
      materialization: "local",
      allowlist_required: false,
      allowed_agent_modes: ["read_only", "trusted_local_write"],
      safety: {
        local_writes: false,
        network: false,
        external_side_effects: false,
      },
    },
    {
      registration_kind: "tool",
      id: "repository.write-file",
      owner: {
        capability_id: "repository",
        capability_version: "1",
        capability_kind: "execution",
      },
      presentation: { title: "Write file" },
      protocol: "local",
      input_schema: {},
      output_schema: {},
      runtime_requirements: ["tool_calling"],
      materialization: "local",
      allowlist_required: false,
      allowed_agent_modes: ["trusted_local_write"],
      safety: {
        local_writes: true,
        network: false,
        external_side_effects: false,
      },
    },
  ],
}

describe("agent tool authority", () => {
  it("derives local choices from the loaded catalog and fails closed on mode", () => {
    const tools = localAgentTools(catalog)
    expect(tools.map((tool) => tool.id)).toEqual([
      "repository.read-file",
      "repository.write-file",
    ])
    expect(agentToolAllowed(tools[0]!, "read_only")).toBe(true)
    expect(agentToolAllowed(tools[1]!, "read_only")).toBe(false)
    expect(agentToolAllowed(tools[1]!, "trusted_local_write")).toBe(true)
  })

  it("does not infer authority when the registry omits allowed modes", () => {
    const tool = { ...localAgentTools(catalog)[0]!, allowed_agent_modes: undefined }
    expect(agentToolAllowed(tool, "read_only")).toBe(false)
  })
})
