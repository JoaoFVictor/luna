import type { AnyLunaToolDefinition } from "../../core/tools/contracts.js";
import {
  repositoryContextLocalTools
} from "../../capabilities/repository-context/tools.js";
import {
  repositoryToolCatalog
} from "../../capabilities/repository/tool-catalog.js";

export const nativeLocalToolCatalog = {
  ...repositoryToolCatalog,
  ...repositoryContextLocalTools
} satisfies Record<string, AnyLunaToolDefinition>;
