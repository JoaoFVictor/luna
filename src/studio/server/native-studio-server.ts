import type { AppConfig } from "../../core/config/schemas.js";
import type { LunaPlatform } from "../../platform/native/native-platform.js";
import type { StudioAdapterPreviewPort } from "../application/inputs/adapter-preview-port.js";
import { createNativeStudioServices } from "./native-services.js";
import { onceStudioServiceDisposer } from "./service-lifecycle.js";
import {
  startStudioServer,
  type StartStudioServerOptions,
  type StudioServerHandle
} from "./studio-server.js";

export type StartNativeStudioServerOptions = Omit<
  StartStudioServerOptions,
  "services"
> & {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app?: AppConfig;
  readonly platform?: Pick<
    LunaPlatform,
    "capabilityRegistry" | "capabilityManifests" | "inputAdapterRegistry"
  >;
  readonly previews?: StudioAdapterPreviewPort;
  readonly startServer?: typeof startStudioServer;
  readonly createServices?: typeof createNativeStudioServices;
};

export async function startNativeStudioServer(
  options: StartNativeStudioServerOptions
): Promise<StudioServerHandle> {
  const createServices = options.createServices ?? createNativeStudioServices;
  const services = await createServices({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    ...(options.app === undefined ? {} : { app: options.app }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.previews === undefined ? {} : { previews: options.previews })
  });
  const dispose = onceStudioServiceDisposer(services.dispose);
  const ownedServices = { ...services, dispose };
  const start = options.startServer ?? startStudioServer;
  try {
    return await start({
      services: ownedServices,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.sessionTtlMs === undefined
        ? {}
        : { sessionTtlMs: options.sessionTtlMs }),
      ...(options.bodyLimitBytes === undefined
        ? {}
        : { bodyLimitBytes: options.bodyLimitBytes }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.listen === undefined ? {} : { listen: options.listen }),
      ...(options.output === undefined ? {} : { output: options.output })
    });
  } catch (cause) {
    try {
      await dispose();
    } catch {
      // Preserve the authoritative server startup failure.
    }
    throw cause;
  }
}
