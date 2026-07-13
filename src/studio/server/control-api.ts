import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  parseStudioRequest,
  registerStudioControlApiBoundary,
  STUDIO_API_PREFIX
} from "./control-api-boundary.js";
import {
  registerStudioControlApiBaseRoutes,
  type StudioControlApiQueries
} from "./routes/control-api-base.js";
import {
  registerStudioAgentTestBenchRoutes,
  type StudioAgentTestBenchControl
} from "./routes/agent-test-bench.js";
import {
  registerStudioArtifactRoutes,
  type StudioArtifactControl
} from "./routes/artifacts.js";
import {
  registerStudioConfigurationRoutes,
  type StudioConfigurationControl
} from "./routes/configuration.js";
import {
  registerStudioDraftAuthoringRoutes,
  type StudioDraftAuthoringControl
} from "./routes/drafts.js";
import {
  registerStudioExpressionRoutes,
  type StudioExpressionControl
} from "./routes/expressions.js";
import {
  registerStudioInputRoutingRoutes,
  type StudioInputRoutingControl
} from "./routes/input-routing.js";
import {
  registerStudioResourceHistoryRoutes,
  type StudioResourceHistoryControl
} from "./routes/resource-history.js";
import {
  registerStudioRunLaunchRoutes,
  type StudioRunLaunchControl
} from "./routes/run-launch.js";
import {
  registerStudioRunLogRoutes,
  type StudioRunLogControl
} from "./routes/run-logs.js";
import {
  registerStudioRunRoutes,
  type StudioRunControl
} from "./routes/runs.js";
import {
  registerStudioRunInterruptRoutes,
  type StudioRunInterruptControl
} from "./routes/run-interrupts.js";
import {
  registerStudioRunOutputFixtureRoutes,
  type StudioRunOutputFixtureControl
} from "./routes/run-output-fixtures.js";
import {
  registerStudioSchemaRoutes,
  type StudioSchemaControl
} from "./routes/schemas.js";
import type { StudioLocalSessionManager } from "./security/local-session.js";

export type { StudioControlApiQueries } from "./routes/control-api-base.js";

export type StudioControlApiOptions = {
  readonly sessions: StudioLocalSessionManager;
  readonly queries: StudioControlApiQueries;
  readonly inputRouting: StudioInputRoutingControl;
  readonly expressions?: StudioExpressionControl;
  readonly schemas?: StudioSchemaControl;
  readonly runs?: StudioRunControl;
  readonly runInterrupts?: StudioRunInterruptControl;
  readonly runLaunch?: StudioRunLaunchControl;
  readonly artifacts?: StudioArtifactControl;
  readonly runLogs?: StudioRunLogControl;
  readonly drafts?: StudioDraftAuthoringControl;
  readonly runOutputFixtures?: StudioRunOutputFixtureControl;
  readonly configuration?: StudioConfigurationControl;
  readonly resourceHistory?: StudioResourceHistoryControl;
  readonly agentTest?: StudioAgentTestBenchControl;
};

export async function registerStudioControlApi(
  server: FastifyInstance,
  options: StudioControlApiOptions
): Promise<void> {
  const requests = registerStudioControlApiBoundary(server, options.sessions);
  const launchContextFor = (request: FastifyRequest) => {
    const authenticated = requests.authenticatedSessionFor(request);
    return {
      actor_id: authenticated.principal.id,
      actor_binding: authenticated.actorBinding,
      request_id: requests.requestIdFor(request)
    };
  };
  const agentTestContextFor = (request: FastifyRequest) => {
    const authenticated = requests.authenticatedSessionFor(request);
    return {
      actor_binding: authenticated.actorBinding,
      request_id: requests.requestIdFor(request)
    };
  };

  registerStudioControlApiBaseRoutes(server, {
    sessions: options.sessions,
    queries: options.queries,
    principalFor: requests.principalFor
  });

  await registerStudioInputRoutingRoutes(server, {
    apiPrefix: STUDIO_API_PREFIX,
    control: options.inputRouting,
    principalFor: requests.principalFor,
    parseRequest: parseStudioRequest
  });
  if (options.drafts !== undefined) {
    await registerStudioDraftAuthoringRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.drafts,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.runOutputFixtures !== undefined) {
    await registerStudioRunOutputFixtureRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.runOutputFixtures,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.configuration !== undefined) {
    await registerStudioConfigurationRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.configuration,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.resourceHistory !== undefined) {
    await registerStudioResourceHistoryRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.resourceHistory,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.expressions !== undefined) {
    await registerStudioExpressionRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.expressions,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.schemas !== undefined) {
    await registerStudioSchemaRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.schemas,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.runs !== undefined) {
    await registerStudioRunRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.runs,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.runInterrupts !== undefined) {
    await registerStudioRunInterruptRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.runInterrupts,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.runLaunch !== undefined) {
    await registerStudioRunLaunchRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.runLaunch,
      launchContextFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.agentTest !== undefined) {
    await registerStudioAgentTestBenchRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.agentTest,
      launchContextFor: agentTestContextFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.artifacts !== undefined) {
    await registerStudioArtifactRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.artifacts,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
  if (options.runLogs !== undefined) {
    await registerStudioRunLogRoutes(server, {
      apiPrefix: STUDIO_API_PREFIX,
      control: options.runLogs,
      principalFor: requests.principalFor,
      parseRequest: parseStudioRequest
    });
  }
}
