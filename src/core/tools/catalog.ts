import type { AnyLunaToolDefinition } from "./contracts.js";
import {
  repositoryLocalTools
} from "./repository.js";

export const lunaToolCatalog = {
  ...repositoryLocalTools
} satisfies Record<string, AnyLunaToolDefinition>;
