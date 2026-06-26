import { describe, expect, it } from "vitest";
import {
  capabilityManifest
} from "../../../src/core/capabilities/manifest.js";
import {
  createCapabilityRegistry
} from "../../../src/core/capabilities/registry.js";
import {
  resolveToolCatalog
} from "../../../src/core/tools/resolved-catalog.js";
import type { AnyLunaToolDefinition } from "../../../src/core/tools/contracts.js";
import { officialCapabilityRegistry } from "../../../src/capabilities/registry.js";
import { lunaToolCatalog } from "../../../src/core/tools/catalog.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {}
} as const;

const localTool = {
  id: "repository.status",
  description: "Get status.",
  parameters: schema,
  safety: {
    localWrites: false,
    network: false,
    externalSideEffects: false
  },
  modes: ["read_only", "trusted_local_write"],
  createHandler: () => async () => ({ status: "clean" })
} satisfies AnyLunaToolDefinition;

const registry = createCapabilityRegistry([
  capabilityManifest({
    id: "repository",
    kind: "execution",
    version: "2026.06.26",
    tools: {
      "repository.status": {
        id: "repository.status",
        protocol: "local",
        input_schema: schema,
        output_schema: schema,
        runtime_requirements: ["tool_calling"]
      }
    }
  }),
  capabilityManifest({
    id: "github",
    kind: "execution",
    version: "2026.06.26",
    tools: {
      "github.get_pull_request": {
        id: "github.get_pull_request",
        protocol: "mcp",
        input_schema: schema,
        output_schema: schema,
        runtime_requirements: ["tool_calling", "mcp_tools"],
        allowlist_required: true
      }
    }
  })
]);

describe("resolved tool catalog", () => {
  it("combines capability-registered local tools with local contracts", () => {
    const catalog = resolveToolCatalog({
      registry,
      local_tools: { [localTool.id]: localTool },
      requested_local_tool_ids: ["repository.status"],
      requested_mcp_server_ids: [],
      agent_mode: "read_only",
      mcp_config: { mcp_servers: [] }
    });

    expect(catalog).toMatchObject({
      tools: [
        {
          id: "repository.status",
          protocol: "local",
          source: "local_contract"
        }
      ],
      runtime_requirements: ["tool_calling"]
    });
    expect(catalog.tools[0]).toHaveProperty("local", localTool);
  });

  it("adds only MCP tools allowed by explicit MCP server policy", () => {
    const catalog = resolveToolCatalog({
      registry,
      local_tools: { [localTool.id]: localTool },
      requested_local_tool_ids: [],
      requested_mcp_server_ids: ["github"],
      agent_mode: "read_only",
      mcp_config: {
        mcp_servers: [
          {
            id: "github",
            transport: "streamable-http",
            url_env: "LUNA_MCP_GITHUB_URL",
            headers: {},
            allowed_tools: ["get_pull_request"],
            allowed_agent_modes: ["read_only"],
            timeout_ms: 30_000
          }
        ]
      }
    });

    expect(catalog.tools.map((tool) => tool.id)).toEqual([
      "github.get_pull_request"
    ]);
    expect(catalog.runtime_requirements).toEqual(["tool_calling", "mcp_tools"]);
  });

  it("rejects local tools without local contracts and MCP tools without allowlist policy", () => {
    expect(() =>
      resolveToolCatalog({
        registry,
        local_tools: {},
        requested_local_tool_ids: ["repository.status"],
        requested_mcp_server_ids: [],
        agent_mode: "read_only",
        mcp_config: { mcp_servers: [] }
      })
    ).toThrow(expect.objectContaining({ code: "tool_catalog_local_contract_missing" }));

    expect(() =>
      resolveToolCatalog({
        registry,
        local_tools: { [localTool.id]: localTool },
        requested_local_tool_ids: [],
        requested_mcp_server_ids: [],
        agent_mode: "read_only",
        mcp_config: { mcp_servers: [] }
      })
    ).not.toThrow();

    expect(() =>
      resolveToolCatalog({
        registry,
        local_tools: { [localTool.id]: localTool },
        requested_local_tool_ids: [],
        requested_mcp_server_ids: ["github"],
        agent_mode: "read_only",
        mcp_config: {
          mcp_servers: [
            {
              id: "github",
              transport: "streamable-http",
              url_env: "LUNA_MCP_GITHUB_URL",
              headers: {},
              allowed_tools: ["delete_repo"],
              allowed_agent_modes: ["read_only"],
              timeout_ms: 30_000
            }
          ]
        }
      })
    ).toThrow(expect.objectContaining({ code: "tool_catalog_mcp_tool_not_registered" }));
  });

  it("resolves Luna's official local tool catalog through official capabilities", () => {
    const catalog = resolveToolCatalog({
      registry: officialCapabilityRegistry,
      local_tools: lunaToolCatalog,
      requested_local_tool_ids: ["repository.status", "repository.diff-summary"],
      requested_mcp_server_ids: [],
      agent_mode: "read_only",
      mcp_config: { mcp_servers: [] }
    });

    expect(catalog.tools.map((tool) => tool.id)).toEqual([
      "repository.status",
      "repository.diff-summary"
    ]);
    expect(catalog.tools.map((tool) => tool.source)).toEqual([
      "local_contract",
      "local_contract"
    ]);
    expect(catalog.runtime_requirements).toEqual(["tool_calling"]);
  });
});
