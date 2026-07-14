import type { AnyLunaToolDefinition } from "../../core/tools/contracts.js";
import {
  repositoryLocalTools
} from "./repository.js";

export const repositoryToolCatalog = {
  ...repositoryLocalTools
} satisfies Record<string, AnyLunaToolDefinition>;
