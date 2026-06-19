import type { Skill, ToolDefinition } from "@flue/runtime";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AgentDefinition } from "./agent-definition.js";
import { resolveFlueMcpTools } from "./flue-mcp-capabilities.js";
import { resolveFlueTools } from "./flue-tool-registry.js";
import type { McpConfig } from "./mcp-config.js";
import { isInsideRoot } from "./path-security.js";

export type ResolvedFlueAgentCapabilities = {
  skills: Skill[];
  tools: ToolDefinition[];
  close(): Promise<void>;
};

type WorkspaceSkill = {
  name: string;
  description: string;
  __flueWorkspaceSkill: true;
  directory: string;
  skillMdPath: string;
};

const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1)
});

function capabilityError(
  message: string,
  cause: unknown
): Error & { code: "flue_capability_resolve_failed" } {
  const error = new Error(message, { cause }) as Error & {
    code: "flue_capability_resolve_failed";
  };
  error.code = "flue_capability_resolve_failed";

  return error;
}

function isUnknownToolError(error: unknown): boolean {
  return (error as { code?: unknown }).code === "flue_tool_unknown";
}

function isKnownMcpError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "mcp_server_unknown" ||
    code === "mcp_agent_mode_not_allowed" ||
    code === "mcp_env_missing" ||
    code === "mcp_server_connect_failed"
  );
}

function parseSkillFrontmatter(
  content: string,
  skillPath: string
): z.infer<typeof SkillFrontmatterSchema> {
  const match = content
    .replace(/^\uFEFF/, "")
    .match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);

  if (match === null) {
    throw new Error(`Skill is missing YAML frontmatter: ${skillPath}`);
  }

  return SkillFrontmatterSchema.parse(YAML.parse(match[1] ?? ""));
}

async function loadSkill(
  agentDirectory: string,
  skillPath: string
): Promise<WorkspaceSkill> {
  if (path.isAbsolute(skillPath)) {
    throw new Error(
      `Skill path must be relative to the agent directory: ${skillPath}`
    );
  }

  const capabilityRoot = path.dirname(path.dirname(agentDirectory));
  const skillMdPath = path.resolve(agentDirectory, skillPath);
  const capabilityRootReal = await realpath(capabilityRoot);
  const resolvedSkillMdPath = await realpath(skillMdPath);

  if (!isInsideRoot(capabilityRootReal, resolvedSkillMdPath)) {
    throw new Error(`Skill path resolves outside Luna capability root: ${skillPath}`);
  }

  const directory = path.dirname(resolvedSkillMdPath);
  const content = await readFile(resolvedSkillMdPath, "utf8");
  const frontmatter = parseSkillFrontmatter(content, resolvedSkillMdPath);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    __flueWorkspaceSkill: true,
    directory,
    skillMdPath: resolvedSkillMdPath
  };
}

export async function resolveFlueAgentCapabilities({
  agent,
  cwd,
  mcpConfig,
  env
}: {
  agent: AgentDefinition;
  cwd: string;
  mcpConfig?: McpConfig;
  env?: Record<string, string | undefined>;
}): Promise<ResolvedFlueAgentCapabilities> {
  try {
    const skills = await Promise.all(
      (agent.skills ?? []).map((skillPath) =>
        loadSkill(agent.directory, skillPath)
      )
    );
    const localTools = resolveFlueTools({ ids: agent.tools ?? [], cwd });
    const mcp = await resolveFlueMcpTools({
      ids: agent.mcp_servers ?? [],
      agentMode: agent.mode,
      config: mcpConfig ?? { mcp_servers: [] },
      env: env ?? process.env
    });

    return {
      skills,
      tools: [...localTools, ...mcp.tools],
      close: mcp.close
    };
  } catch (cause) {
    if (isUnknownToolError(cause) || isKnownMcpError(cause)) {
      throw cause;
    }

    throw capabilityError(
      `Failed to resolve Flue capabilities for agent: ${agent.id}`,
      cause
    );
  }
}
