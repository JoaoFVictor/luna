import type { InputAdapterRegistry } from "../../../adapters/registry.js";
import type { RegisteredInputAdapter } from "../../../adapters/types.js";
import type { RouterDefinition } from "../../../core/router/router-definition.js";
import {
  StudioAdapterRoutingPreviewSchema,
  type StudioAdapterRoutingPreview
} from "../../contracts/input-routing.js";
import type { StudioAdapterPreviewPort } from "./adapter-preview-port.js";
import { resolveStudioInputAdapterPreview } from "./input-adapters.js";
import type { StudioRoutingSimulationPort } from "../routing/routing-simulator.js";

type StudioAdapterRegistry = Pick<
  InputAdapterRegistry<RegisteredInputAdapter>,
  "ids" | "require"
>;

export async function previewStudioInputRoute(
  request: unknown,
  dependencies: {
    readonly registry: StudioAdapterRegistry;
    readonly previews?: StudioAdapterPreviewPort;
    readonly routing: RouterDefinition;
    readonly routingSimulator: StudioRoutingSimulationPort;
    readonly signal?: AbortSignal;
  }
): Promise<StudioAdapterRoutingPreview> {
  const resolved = await resolveStudioInputAdapterPreview(request, {
    registry: dependencies.registry,
    ...(dependencies.previews === undefined
      ? {}
      : { previews: dependencies.previews }),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal })
  });
  const routing = await dependencies.routingSimulator.simulate(
    { invocation: resolved.invocation },
    dependencies.routing,
    dependencies.signal === undefined
      ? {}
      : { signal: dependencies.signal }
  );

  // Parsing the public projection here prevents the private invocation from
  // crossing the application boundary by construction.
  return StudioAdapterRoutingPreviewSchema.parse({
    adapter: resolved.preview,
    routing
  });
}
