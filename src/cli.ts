import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadYamlFile } from "./core/config/loader.js";
import {
  AppConfigSchema,
  type AppConfig
} from "./core/config/schemas.js";
import {
  parseWorkflowTarget as parseRouterWorkflowTarget,
  routeInvocation
} from "./core/router/router.js";
import {
  type RouterDefinition
} from "./core/router/router-definition.js";
import { loadRouterDefinition } from "./core/router/router-definition-loader.js";
import {
  createLunaTargetExecutor,
  resolveRuntimeConfigRoot,
  type TargetExecutor
} from "./runtime/composition/target-executor.js";
import {
  defaultAdapterContext,
  unknownAdapterError
} from "./adapters/registry.js";
import type { AdapterContext } from "./adapters/types.js";
import type { LunaPlatform } from "./platform/native/native-platform.js";
import { loadNativeLunaPlatform } from "./platform/native/native-platform-loader.js";
import { loadWebhookConfig, type WebhookConfig } from "./webhooks/config.js";
import {
  startWebhookServer,
  type StartWebhookServerDeps
} from "./webhooks/server.js";
import {
  startWebhookWorker,
  type StartWebhookWorkerDeps
} from "./webhooks/worker.js";
import {
  startNativeStudioServer,
  type StartNativeStudioServerOptions
} from "./studio/server/native-studio-server.js";
import type { StudioServerHandle } from "./studio/server/studio-server.js";
import {
  InvocationSchema,
  type Invocation,
  type RouteTarget
} from "./core/router/invocation.js";
import { assertJsonValue, type JsonValue } from "./core/json/value.js";

export type CliArgs = {
  command: "run";
  target?: RouteTarget;
  input: string;
} | {
  command: "run";
  target?: RouteTarget;
  from: string;
  value: string;
} | {
  command: "resume";
  target: RouteTarget;
  thread: string;
  checkpoint: string;
  interrupt: string;
  decision: JsonValue;
} | {
  command: "webhook-server";
  host?: string;
  port?: number;
} | {
  command: "webhook-worker";
  concurrency?: number;
} | {
  command: "studio";
  host?: string;
  port?: number;
};

export type ResolvedWebhookServerDeps = StartWebhookServerDeps & {
  projectRoot: string;
  configRoot: string;
  config: WebhookConfig;
  webhookProviderRegistry: LunaPlatform["webhookProviderRegistry"];
};

export type ResolvedWebhookWorkerDeps = StartWebhookWorkerDeps & {
  projectRoot: string;
  configRoot: string;
  config: WebhookConfig;
  routing: RouterDefinition;
  targetExecutor: TargetExecutor;
};

export type ResolvedStudioServerDeps = StartNativeStudioServerOptions & {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app: AppConfig;
};

export type MainDependencies = {
  targetExecutor?: TargetExecutor;
  routeInvocation?: typeof routeInvocation;
  routing?: RouterDefinition;
  adapterContext?: AdapterContext;
  platform?: Pick<
    LunaPlatform,
    "inputAdapterRegistry" | "runWorkflow" | "resumeWorkflow"
  >;
  webhookProviderRegistry?: LunaPlatform["webhookProviderRegistry"];
  startWebhookServer?: (deps: ResolvedWebhookServerDeps) => Promise<void>;
  startWebhookWorker?: (deps: ResolvedWebhookWorkerDeps) => Promise<void>;
  startStudioServer?: (
    deps: ResolvedStudioServerDeps
  ) => Promise<StudioServerHandle | void>;
  studioOutput?: { readonly write: (message: string) => void };
  projectRoot?: string;
  env?: { LUNA_CONFIG_ROOT?: string };
};

class CliError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

function cliError(code: string, message: string): CliError {
  return new CliError(code, message);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(startPath = process.cwd()): Promise<string> {
  let current = path.resolve(startPath);

  while (true) {
    if (await pathExists(path.join(current, "package.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw cliError(
        "project_root_not_found",
        `Could not find project root from ${startPath}`
      );
    }

    current = parent;
  }
}

export function parseCliArgs(args: string[]): CliArgs {
  const [command, ...rest] = args;

  if (command === "webhook-server" || command === "studio") {
    const allowedFlags = new Set(["--host", "--port"]);
    const unsupportedFlag = rest.find(
      (argument) => argument.startsWith("--") && !allowedFlags.has(argument)
    );
    if (unsupportedFlag !== undefined) {
      throw cliError(
        "unsupported_flag",
        `Unsupported ${command} flag: ${unsupportedFlag}`
      );
    }

    const hostFlagIndex = rest.indexOf("--host");
    const host = hostFlagIndex >= 0
      ? requiredFlag(rest, "--host", "Missing required --host <host>")
      : undefined;
    const portFlagIndex = rest.indexOf("--port");
    const port = portFlagIndex >= 0
      ? parsePositiveIntegerFlag(
          requiredFlag(rest, "--port", "Missing required --port <port>"),
          "--port"
        )
      : undefined;

    return {
      command,
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port })
    };
  }

  if (command === "webhook-worker") {
    const allowedFlags = new Set(["--concurrency"]);
    const unsupportedFlag = rest.find(
      (argument) => argument.startsWith("--") && !allowedFlags.has(argument)
    );
    if (unsupportedFlag !== undefined) {
      throw cliError(
        "unsupported_flag",
        `Unsupported webhook-worker flag: ${unsupportedFlag}`
      );
    }

    const concurrencyFlagIndex = rest.indexOf("--concurrency");
    const concurrency = concurrencyFlagIndex >= 0
      ? parsePositiveIntegerFlag(
          requiredFlag(rest, "--concurrency", "Missing required --concurrency <n>"),
          "--concurrency"
        )
      : undefined;

    return {
      command,
      ...(concurrency === undefined ? {} : { concurrency })
    };
  }

  if (command === "run") {
    const allowedFlags = new Set(["--target", "--input", "--from"]);
    const unsupportedFlag = rest.find(
      (argument) => argument.startsWith("--") && !allowedFlags.has(argument)
    );
    const targetFlagIndex = rest.indexOf("--target");
    const targetValue =
      targetFlagIndex >= 0 ? rest[targetFlagIndex + 1] : undefined;
    const inputFlagIndex = rest.indexOf("--input");
    const input = inputFlagIndex >= 0 ? rest[inputFlagIndex + 1] : undefined;
    const fromFlagIndex = rest.indexOf("--from");
    const from = fromFlagIndex >= 0 ? rest[fromFlagIndex + 1] : undefined;
    const value = fromFlagIndex >= 0 ? rest[fromFlagIndex + 2] : undefined;

    if (unsupportedFlag !== undefined) {
      throw cliError("unsupported_flag", `Unsupported run flag: ${unsupportedFlag}`);
    }
    if (targetFlagIndex >= 0 && !targetValue) {
      throw cliError("invalid_target", "Missing required --target workflow:<id>");
    }

    const target =
      targetValue === undefined ? undefined : parseWorkflowTarget(targetValue);

    if (input && from) {
      throw cliError("ambiguous_input", "Use either --input or --from, not both");
    }
    if (from) {
      if (!value) {
        throw cliError("missing_from_value", "Missing required adapter input value");
      }

      return { command, target, from, value };
    }
    if (!input) {
      throw cliError("missing_input", "Missing required --input <path>");
    }

    return { command, target, input };
  }

  if (command === "resume") {
    const allowedFlags = new Set([
      "--target",
      "--thread",
      "--checkpoint",
      "--interrupt",
      "--decision"
    ]);
    const unsupportedFlag = rest.find(
      (argument) => argument.startsWith("--") && !allowedFlags.has(argument)
    );
    if (unsupportedFlag !== undefined) {
      throw cliError("unsupported_flag", `Unsupported resume flag: ${unsupportedFlag}`);
    }

    const target = requiredFlag(rest, "--target", "Missing required --target workflow:<id>");
    const thread = requiredFlag(rest, "--thread", "Missing required --thread <run_id>");
    const checkpoint = requiredFlag(rest, "--checkpoint", "Missing required --checkpoint <checkpoint_id>");
    const interrupt = requiredFlag(rest, "--interrupt", "Missing required --interrupt <interrupt_id>");
    const decisionText = requiredFlag(rest, "--decision", "Missing required --decision <json>");
    let decision: unknown;
    try {
      decision = JSON.parse(decisionText);
      assertJsonValue(decision);
    } catch (error) {
      throw cliError(
        "decision_invalid",
        error instanceof Error ? error.message : "Resume decision must be JSON"
      );
    }

    return {
      command,
      target: parseWorkflowTarget(target),
      thread,
      checkpoint,
      interrupt,
      decision
    };
  }

  throw cliError(
    "unknown_command",
    "Expected command: run, resume, studio, webhook-server, or webhook-worker"
  );
}

function requiredFlag(args: string[], flag: string, message: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw cliError("missing_flag", message);
  }

  return value;
}

function parsePositiveIntegerFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw cliError(
      "invalid_flag",
      `Invalid ${flag} value "${value}". Expected a positive integer.`
    );
  }

  return parsed;
}

export function parseWorkflowTarget(value: string): RouteTarget {
  try {
    return parseRouterWorkflowTarget(value);
  } catch {
    throw cliError(
      "invalid_target",
      `Invalid --target value "${value}". Expected workflow:<id>.`
    );
  }
}

export async function loadInvocationFromFile(filePath: string): Promise<Invocation> {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw cliError(
      "invocation_invalid",
      error instanceof Error ? error.message : "Unable to read invocation JSON"
    );
  }

  const result = InvocationSchema.safeParse(parsedJson);
  if (!result.success) {
    throw cliError("invocation_invalid", result.error.message);
  }

  return result.data;
}

export function resolveCliConfigRoot(
  projectRoot: string,
  env: { LUNA_CONFIG_ROOT?: string } = process.env
): string {
  return resolveRuntimeConfigRoot(projectRoot, env);
}

export async function loadRoutingDefinition(
  projectRoot: string,
  env: { LUNA_CONFIG_ROOT?: string } = process.env,
  app?: AppConfig
): Promise<RouterDefinition> {
  const configRoot = resolveCliConfigRoot(projectRoot, env);
  return await loadRouterDefinition({
    configRoot,
    ...(app === undefined ? {} : { app })
  });
}

export async function main(
  args: string[],
  deps: MainDependencies = {}
): Promise<number> {
  const parsedArgs = parseCliArgs(args);
  const projectRoot = deps.projectRoot ?? (await findProjectRoot());
  const configRoot = resolveCliConfigRoot(projectRoot, deps.env);
  let app: AppConfig | undefined;
  const loadApp = async () => {
    app ??= await loadYamlFile(
      path.join(configRoot, "app.yaml"),
      AppConfigSchema
    );
    return app;
  };
  let loadedPlatform:
    | Pick<LunaPlatform, "inputAdapterRegistry" | "runWorkflow" | "resumeWorkflow">
    | undefined;
  const loadPlatform = async () => {
    loadedPlatform ??= deps.platform ?? await loadNativeLunaPlatform({
      projectRoot,
      configRoot,
      app: await loadApp()
    });
    return loadedPlatform;
  };
  let loadedWebhookProviderRegistry: LunaPlatform["webhookProviderRegistry"] | undefined;
  const loadWebhookProviderRegistry = async () => {
    loadedWebhookProviderRegistry ??=
      deps.webhookProviderRegistry ??
      (await loadNativeLunaPlatform({
        projectRoot,
        configRoot,
        app: await loadApp()
      })).webhookProviderRegistry;
    return loadedWebhookProviderRegistry;
  };
  let invocation: Invocation;

  if (parsedArgs.command === "studio") {
    const starter = deps.startStudioServer ?? startNativeStudioServer;
    await starter({
      projectRoot,
      configRoot,
      app: await loadApp(),
      ...(parsedArgs.host === undefined ? {} : { host: parsedArgs.host }),
      ...(parsedArgs.port === undefined ? {} : { port: parsedArgs.port }),
      output: deps.studioOutput ?? process.stdout
    });
    return 0;
  }

  if (parsedArgs.command === "webhook-server") {
    const loadedConfig = await loadWebhookConfig(configRoot);
    const config: WebhookConfig = {
      ...loadedConfig,
      server: {
        ...loadedConfig.server,
        ...(parsedArgs.host === undefined ? {} : { host: parsedArgs.host }),
        ...(parsedArgs.port === undefined ? {} : { port: parsedArgs.port })
      }
    };
    const starter = deps.startWebhookServer ?? startWebhookServer;
    await starter({
      projectRoot,
      configRoot,
      config,
      webhookProviderRegistry: await loadWebhookProviderRegistry()
    });

    return 0;
  }

  if (parsedArgs.command === "webhook-worker") {
    const platform = await loadPlatform();
    const loadedConfig = await loadWebhookConfig(configRoot);
    const config: WebhookConfig = {
      ...loadedConfig,
      worker: {
        ...loadedConfig.worker,
        ...(parsedArgs.concurrency === undefined
          ? {}
          : { concurrency: parsedArgs.concurrency })
      }
    };
    const routing =
      deps.routing ?? (await loadRoutingDefinition(projectRoot, deps.env, await loadApp()));
    const targetExecutor =
      deps.targetExecutor ??
      createLunaTargetExecutor({
        projectRoot,
        configRoot,
        runWorkflow: platform.runWorkflow
      });
    const starter = deps.startWebhookWorker ?? startWebhookWorker;
    await starter({
      projectRoot,
      configRoot,
      config,
      routing,
      targetExecutor
    });

    return 0;
  }

  if (parsedArgs.command === "resume") {
    const platform = await loadPlatform();
    await platform.resumeWorkflow({
      projectRoot,
      configRoot,
      target: parsedArgs.target,
      thread_id: parsedArgs.thread,
      checkpoint_id: parsedArgs.checkpoint,
      interrupt_id: parsedArgs.interrupt,
      decision: parsedArgs.decision
    });

    return 0;
  }

  if ("input" in parsedArgs) {
    invocation = await loadInvocationFromFile(parsedArgs.input);
  } else {
    const registry = (await loadPlatform()).inputAdapterRegistry;
    const adapter = registry.get(parsedArgs.from);
    if (adapter === undefined) {
      throw unknownAdapterError(parsedArgs.from, registry);
    }

    const context =
      deps.adapterContext ?? defaultAdapterContext(projectRoot, configRoot);
    invocation = await adapter.load(
      { kind: "cli", value: parsedArgs.value },
      context
    );
  }

  if (parsedArgs.target !== undefined) {
    invocation = { ...invocation, target: parsedArgs.target };
  }

  const platform = await loadPlatform();
  const routing =
    deps.routing ?? (await loadRoutingDefinition(projectRoot, deps.env, await loadApp()));
  const route = deps.routeInvocation ?? routeInvocation;
  const target = await route(invocation, routing);
  const targetExecutor =
    deps.targetExecutor ??
    createLunaTargetExecutor({
      projectRoot,
      configRoot,
      runWorkflow: platform.runWorkflow
    });

  return await targetExecutor.execute({ invocation, target });
}

async function runCli(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
