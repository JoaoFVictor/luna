import type { AppConfig } from "../../core/config/schemas.js";
import type { StudioAdapterPreviewPort } from "../application/inputs/adapter-preview-port.js";
import { createNativeStudioServices } from "./native-services.js";
import type { NativeStudioServicesOptions } from "./native-services.js";
import { onceStudioServiceDisposer } from "./service-lifecycle.js";
import { defaultStudioFrontendRoot } from "./frontend-assets.js";
import { assertSupportedStudioContainerCheckout } from "./studio-container-checkout.js";
import {
  startStudioServer,
  type StartStudioServerOptions,
  type StudioServerHandle
} from "./studio-server.js";

export type StartNativeStudioServerOptions = Omit<
  StartStudioServerOptions,
  "services" | "frontend"
> & {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly app?: AppConfig;
  readonly platform?: NativeStudioServicesOptions["platform"];
  readonly previews?: StudioAdapterPreviewPort;
  readonly startServer?: typeof startStudioServer;
  readonly createServices?: typeof createNativeStudioServices;
  readonly frontendRoot?: string | false;
  readonly stateRoot?: string;
};

export async function startNativeStudioServer(
  options: StartNativeStudioServerOptions
): Promise<StudioServerHandle> {
  await assertSupportedStudioContainerCheckout(options.projectRoot);
  const createServices = options.createServices ?? createNativeStudioServices;
  const services = await createServices({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    ...(options.app === undefined ? {} : { app: options.app }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.previews === undefined ? {} : { previews: options.previews }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot })
  });
  const dispose = onceStudioServiceDisposer(services.dispose);
  const ownedServices = { ...services, dispose };
  const start = options.startServer ?? startStudioServer;
  try {
    return await start({
      services: ownedServices,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.allowNonLoopbackBind === undefined
        ? {}
        : { allowNonLoopbackBind: options.allowNonLoopbackBind }),
      ...(options.publicHost === undefined
        ? {}
        : { publicHost: options.publicHost }),
      ...(options.publicPort === undefined
        ? {}
        : { publicPort: options.publicPort }),
      ...(options.sessionTtlMs === undefined
        ? {}
        : { sessionTtlMs: options.sessionTtlMs }),
      ...(options.bodyLimitBytes === undefined
        ? {}
        : { bodyLimitBytes: options.bodyLimitBytes }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.listen === undefined ? {} : { listen: options.listen }),
      ...(options.output === undefined ? {} : { output: options.output }),
      ...(options.frontendRoot === false
        ? {}
        : {
            frontend: {
              root:
                options.frontendRoot ??
                defaultStudioFrontendRoot(options.projectRoot)
            }
          })
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
