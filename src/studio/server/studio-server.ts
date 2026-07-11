import { isIP } from "node:net";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions
} from "fastify";
import {
  registerStudioControlApi,
  type StudioControlApiOptions
} from "./control-api.js";
import { onceStudioServiceDisposer } from "./service-lifecycle.js";
import { StudioLocalSessionManager } from "./security/local-session.js";

const DEFAULT_STUDIO_HOST = "127.0.0.1";
const DEFAULT_STUDIO_PORT = 43_110;
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const MAX_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

const DEFAULT_FASTIFY_LOGGER: Exclude<
  FastifyServerOptions["logger"],
  boolean | undefined
> = {
  level: "info",
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      'req.headers["x-luna-csrf"]',
      "req.body.capability",
      'res.headers["set-cookie"]'
    ],
    censor: "[Redacted]"
  }
};

export type StudioServerServices = Omit<StudioControlApiOptions, "sessions"> & {
  readonly dispose?: () => Promise<void> | void;
};

export type CreateStudioServerOptions = {
  readonly sessions: StudioLocalSessionManager;
  readonly services: StudioServerServices;
  readonly bodyLimitBytes?: number;
  readonly logger?: FastifyServerOptions["logger"];
  readonly registerControlApi?: typeof registerStudioControlApi;
};

export type StartStudioServerOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly sessionTtlMs?: number;
  readonly bodyLimitBytes?: number;
  readonly services: StudioServerServices;
  readonly logger?: FastifyServerOptions["logger"];
  readonly listen?: (
    server: FastifyInstance,
    address: { readonly host: string; readonly port: number }
  ) => Promise<void>;
  readonly output?: { readonly write: (message: string) => void };
};

export type StudioServerHandle = {
  readonly server: FastifyInstance;
  readonly launchUrl: string;
  close(): Promise<void>;
};

export class StudioServerConfigurationError extends Error {
  readonly code = "studio_server_configuration_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "StudioServerConfigurationError";
  }
}

function assertLoopbackHost(host: string): void {
  const ipVersion = isIP(host);
  const loopback =
    (ipVersion === 4 && host.split(".", 1)[0] === "127") ||
    (ipVersion === 6 && host === "::1");
  if (!loopback) {
    throw new StudioServerConfigurationError(
      "Luna Studio local mode only accepts an explicit loopback IP"
    );
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new StudioServerConfigurationError(
      "Luna Studio port must be an integer from 1 to 65535"
    );
  }
}

function bodyLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_BODY_LIMIT_BYTES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_BODY_LIMIT_BYTES
  ) {
    throw new StudioServerConfigurationError(
      `Luna Studio body limit must be from 1 to ${MAX_BODY_LIMIT_BYTES} bytes`
    );
  }
  return resolved;
}

function authority(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

async function defaultListen(
  server: FastifyInstance,
  address: { readonly host: string; readonly port: number }
): Promise<void> {
  await server.listen(address);
}

async function closeOwnedServer(
  server: FastifyInstance | undefined,
  dispose: () => Promise<void>
): Promise<void> {
  let failure: unknown;

  try {
    if (server !== undefined) {
      await server.close();
    }
  } catch (cause) {
    failure = cause;
  }
  try {
    await dispose();
  } catch (cause) {
    failure ??= cause;
  }
  if (failure !== undefined) {
    throw failure;
  }
}

async function releaseAfterStartupFailure(
  server: FastifyInstance | undefined,
  dispose: () => Promise<void>,
  primaryCause: unknown
): Promise<never> {
  try {
    await closeOwnedServer(server, dispose);
  } catch {
    // Preserve the authoritative startup failure.
  }
  throw primaryCause;
}

export async function createStudioServer(
  options: CreateStudioServerOptions
): Promise<FastifyInstance> {
  const dispose = onceStudioServiceDisposer(options.services.dispose);
  let server: FastifyInstance | undefined;

  try {
    server = Fastify({
      bodyLimit: bodyLimit(options.bodyLimitBytes),
      logger: options.logger ?? DEFAULT_FASTIFY_LOGGER,
      trustProxy: false
    });
    server.addHook("onClose", async () => {
      await dispose();
    });
    const { dispose: _dispose, ...controlApi } = options.services;
    const registerControlApi =
      options.registerControlApi ?? registerStudioControlApi;
    await registerControlApi(server, {
      sessions: options.sessions,
      ...controlApi
    });
    return server;
  } catch (cause) {
    return await releaseAfterStartupFailure(server, dispose, cause);
  }
}

export async function startStudioServer(
  options: StartStudioServerOptions
): Promise<StudioServerHandle> {
  const dispose = onceStudioServiceDisposer(options.services.dispose);
  let server: FastifyInstance | undefined;

  try {
    const host = options.host ?? DEFAULT_STUDIO_HOST;
    const port = options.port ?? DEFAULT_STUDIO_PORT;
    assertLoopbackHost(host);
    assertPort(port);
    const hostAndPort = authority(host, port);
    const origin = `http://${hostAndPort}`;
    const sessions = new StudioLocalSessionManager({
      allowedHosts: [hostAndPort],
      allowedOrigins: [origin],
      ...(options.sessionTtlMs === undefined
        ? {}
        : { sessionTtlMs: options.sessionTtlMs })
    });
    server = await createStudioServer({
      sessions,
      services: { ...options.services, dispose },
      ...(options.bodyLimitBytes === undefined
        ? {}
        : { bodyLimitBytes: options.bodyLimitBytes }),
      ...(options.logger === undefined ? {} : { logger: options.logger })
    });
    const listen = options.listen ?? defaultListen;
    await listen(server, { host, port });
    const capability = sessions.bootstrapCapability();
    const launchUrl = `${origin}/#capability=${encodeURIComponent(capability)}`;
    options.output?.write(`Luna Studio: ${launchUrl}\n`);
    const runningServer = server;
    return {
      server: runningServer,
      launchUrl,
      async close() {
        await closeOwnedServer(runningServer, dispose);
      }
    };
  } catch (cause) {
    return await releaseAfterStartupFailure(server, dispose, cause);
  }
}
