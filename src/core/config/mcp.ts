import path from "node:path";
import { z } from "zod";
import { loadOptionalYamlFile } from "./loader.js";

const NonEmptyStringSchema = z.string().min(1);

const McpHeaderConfigSchema = z
  .object({
    env: NonEmptyStringSchema,
    prefix: NonEmptyStringSchema.optional()
  })
  .strict();

const McpServerConfigSchema = z
  .object({
    id: NonEmptyStringSchema,
    transport: z.enum(["streamable-http", "sse"]),
    url_env: NonEmptyStringSchema,
    headers: z.record(McpHeaderConfigSchema).default({}),
    allowed_tools: z.array(NonEmptyStringSchema).nonempty(),
    allowed_agent_modes: z
      .array(z.enum(["read_only", "trusted_host_local_write"]))
      .nonempty(),
    timeout_ms: z.number().int().positive().default(30_000)
  })
  .strict();

export const McpConfigSchema = z
  .object({
    mcp_servers: z.array(McpServerConfigSchema).default([])
  })
  .strict();

export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

function mcpConfigError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;

  return error;
}

function rejectDuplicateServerIds(config: McpConfig): void {
  const seen = new Set<string>();

  for (const server of config.mcp_servers) {
    if (seen.has(server.id)) {
      throw mcpConfigError(
        `Duplicate MCP server id: ${server.id}`,
        "mcp_config_duplicate_server"
      );
    }

    seen.add(server.id);
  }
}

export async function loadMcpConfig(configRoot: string): Promise<McpConfig> {
  const config = await loadOptionalYamlFile(
    path.join(configRoot, "mcp.yaml"),
    McpConfigSchema
  );
  const resolved = config ?? { mcp_servers: [] };

  rejectDuplicateServerIds(resolved);

  return resolved;
}
