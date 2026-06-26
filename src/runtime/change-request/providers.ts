import type { ChangeRequestBuiltInPorts } from "../../capabilities/change-request/contracts.js";
import { createChangeRequestProviderRegistry } from "../../capabilities/change-request/provider-registry.js";
import { createGitHubChangeRequestProviderFactory } from "../../providers/github/change-request/factory.js";

export function createDefaultChangeRequestPorts(): ChangeRequestBuiltInPorts {
  return {
    providers: createChangeRequestProviderRegistry([
      createGitHubChangeRequestProviderFactory({})
    ])
  };
}
