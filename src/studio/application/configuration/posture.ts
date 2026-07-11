import { lstat } from "node:fs/promises";
import path from "node:path";
import type { InputAdapterRegistry } from "../../../adapters/registry.js";
import type { RegisteredInputAdapter } from "../../../adapters/types.js";
import { loadYamlFile } from "../../../core/config/loader.js";
import {
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  type AppConfig
} from "../../../core/config/schemas.js";
import type { StudioAgentCatalog } from "../../contracts/catalog.js";
import {
  StudioModelConfigurationSchema,
  StudioProviderConfigurationSchema,
  StudioRepositoryRemoteNameSchema,
  StudioRepositoryConfigurationSchema,
  StudioRuntimeConfigurationSchema,
  type StudioModelConfiguration,
  type StudioProviderConfiguration,
  type StudioRepositoryConfiguration,
  type StudioRuntimeConfiguration
} from "../../contracts/configuration.js";
import type { StudioWorkflowCatalog } from "../../contracts/workflow-catalog.js";

const ENV_MODEL = /^\$\{([A-Z0-9_]+)\}$/;
const ENV_MODEL_WITH_FALLBACK = /^\$\{([A-Z0-9_]+):-([^}\s]+)\}$/;

type StudioConfigurationPostureOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app?: AppConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inputAdapters: Pick<
    InputAdapterRegistry<RegisteredInputAdapter>,
    "ids" | "require"
  >;
  readonly agents: () => Promise<StudioAgentCatalog>;
  readonly workflows: () => Promise<StudioWorkflowCatalog>;
};

export type StudioConfigurationPostureService = {
  readonly models: () => Promise<StudioModelConfiguration>;
  readonly repositories: () => Promise<StudioRepositoryConfiguration>;
  readonly providers: () => Promise<StudioProviderConfiguration>;
  readonly runtime: () => Promise<StudioRuntimeConfiguration>;
};

function unavailableDiagnostic(code: string, subject: string) {
  return {
    severity: "error" as const,
    code,
    message: `${subject} configuration is unavailable`
  };
}

function partialCatalogDiagnostic(code: string, subject: string) {
  return {
    severity: "warning" as const,
    code,
    message: `${subject} consumer relationships are partial because the source catalog has diagnostics`
  };
}

function environmentPresent(
  env: Readonly<Record<string, string | undefined>>,
  variable: string
): boolean {
  const value = env[variable];
  return typeof value === "string" && value.trim() !== "";
}

function modelSource(
  model: string,
  env: Readonly<Record<string, string | undefined>>
) {
  const fallback = ENV_MODEL_WITH_FALLBACK.exec(model);
  if (fallback !== null) {
    return {
      kind: "environment" as const,
      variable: fallback[1],
      present: environmentPresent(env, fallback[1]),
      fallback_model: fallback[2]
    };
  }
  const direct = ENV_MODEL.exec(model);
  if (direct !== null) {
    return {
      kind: "environment" as const,
      variable: direct[1],
      present: environmentPresent(env, direct[1])
    };
  }
  return { kind: "literal" as const, model };
}

function redactedRepositoryPath(value: string): {
  readonly display: string;
  readonly kind: "absolute_redacted" | "relative";
} {
  const name = path.basename(path.normalize(value));
  return path.isAbsolute(value)
    ? { display: `…/${name}`, kind: "absolute_redacted" }
    : { display: `./${name}`, kind: "relative" };
}

function safeSkillLabel(value: string): string {
  const normalized = path.normalize(value);
  if (normalized === "SKILL.md") return normalized;
  const owner = path.basename(path.dirname(normalized));
  return `${owner}/SKILL.md`;
}

function projectedRepositoryRemote(value: string) {
  const safeName = StudioRepositoryRemoteNameSchema.safeParse(value);
  return safeName.success
    ? { kind: "name" as const, name: safeName.data }
    : { kind: "redacted" as const };
}

async function repositoryAvailability(
  projectRoot: string,
  configuredPath: string
): Promise<"available" | "unavailable"> {
  const target = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);
  try {
    const stats = await lstat(target);
    return stats.isDirectory() && !stats.isSymbolicLink()
      ? "available"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function createStudioConfigurationPosture(
  options: StudioConfigurationPostureOptions
): StudioConfigurationPostureService {
  const env = options.env ?? process.env;

  return {
    async models() {
      try {
        const [config, agents] = await Promise.all([
          loadYamlFile(
            path.join(options.configRoot, "models.yaml"),
            ModelsConfigSchema
          ),
          options.agents()
        ]);
        const consumers = new Map<string, string[]>();
        for (const agent of agents.agents) {
          const values = consumers.get(agent.model_profile) ?? [];
          values.push(agent.id);
          consumers.set(agent.model_profile, values);
        }
        return StudioModelConfigurationSchema.parse({
          editing: "read_only",
          profiles: Object.entries(config.model_profiles)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, profile]) => ({
              id,
              source: modelSource(profile.model, env),
              reasoning_effort: profile.reasoning_effort,
              transport: profile.transport ?? "auto",
              consumers: (consumers.get(id) ?? []).sort()
            })),
          diagnostics: agents.status === "partial"
            ? [partialCatalogDiagnostic(
                "configuration_model_consumers_partial",
                "Model profile"
              )]
            : []
        });
      } catch {
        return StudioModelConfigurationSchema.parse({
          editing: "read_only",
          profiles: [],
          diagnostics: [
            unavailableDiagnostic(
              "configuration_models_unavailable",
              "Model profile"
            )
          ]
        });
      }
    },

    async repositories() {
      try {
        const [config, workflows] = await Promise.all([
          loadYamlFile(
            path.join(options.configRoot, "repositories.yaml"),
            RepositoriesConfigSchema
          ),
          options.workflows()
        ]);
        const requiredBy = workflows.workflows
          .filter((workflow) => workflow.requires_repository)
          .map((workflow) => workflow.id)
          .sort();
        const repositories = await Promise.all(
          config.repositories.map(async (repository) => {
            const projectedPath = redactedRepositoryPath(repository.path);
            return {
              id: repository.id,
              provider: repository.provider,
              owner: repository.owner,
              name: repository.name,
              path_display: projectedPath.display,
              path_kind: projectedPath.kind,
              remote: projectedRepositoryRemote(repository.remote),
              expected_remote_count:
                repository.expected_remote_urls?.length ?? 0,
              skills: (repository.skills ?? []).map(safeSkillLabel).sort(),
              availability: await repositoryAvailability(
                options.projectRoot,
                repository.path
              ),
              trusted_write_readiness: "not_assessed" as const,
              required_by: requiredBy
            };
          })
        );
        return StudioRepositoryConfigurationSchema.parse({
          editing: "read_only",
          confinement_policy: "not_configured",
          repositories,
          diagnostics: workflows.status === "partial"
            ? [partialCatalogDiagnostic(
                "configuration_repository_consumers_partial",
                "Repository"
              )]
            : []
        });
      } catch {
        return StudioRepositoryConfigurationSchema.parse({
          editing: "read_only",
          confinement_policy: "not_configured",
          repositories: [],
          diagnostics: [
            unavailableDiagnostic(
              "configuration_repositories_unavailable",
              "Repository"
            )
          ]
        });
      }
    },

    async providers() {
      const grouped = new Map<string, string[]>();
      for (const adapterId of options.inputAdapters.ids().sort()) {
        const adapter = options.inputAdapters.require(adapterId);
        const adapterIds = grouped.get(adapter.source) ?? [];
        adapterIds.push(adapter.id);
        grouped.set(adapter.source, adapterIds);
      }
      return StudioProviderConfigurationSchema.parse({
        editing: "read_only",
        providers: [...grouped.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, adapterIds]) => ({
            id,
            adapter_ids: adapterIds.sort(),
            credential_status: "not_checked"
          }))
      });
    },

    async runtime() {
      const app = options.app;
      return StudioRuntimeConfigurationSchema.parse({
        editing: "read_only",
        workflow_runtime_id: app?.workflow_runtime?.id ?? "not_configured",
        agent_runtime_id: app?.agent_runtime?.id ?? "not_configured",
        workspace_strategy: app?.workspace.strategy ?? "not_configured",
        plugin_count: app?.plugins?.length ?? 0,
        option_values_redacted: true
      });
    }
  };
}
