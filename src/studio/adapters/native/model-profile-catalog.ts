import path from "node:path";
import { loadYamlFile } from "../../../core/config/loader.js";
import { ModelsConfigSchema } from "../../../core/config/schemas.js";
import type { StudioModelProfileCatalogPort } from "../../application/drafts/authoring-ports.js";

export class NativeStudioModelProfileCatalog
  implements StudioModelProfileCatalogPort
{
  constructor(private readonly configRoot: string) {}

  async ids(): Promise<readonly string[]> {
    const config = await loadYamlFile(
      path.join(this.configRoot, "models.yaml"),
      ModelsConfigSchema
    );
    return Object.keys(config.model_profiles).sort((left, right) =>
      left.localeCompare(right)
    );
  }
}
