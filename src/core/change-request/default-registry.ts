import { githubChangeRequestProvider } from "../providers/github/change-request-actions.js";
import { createChangeRequestRegistry } from "./registry.js";

export const defaultChangeRequestRegistry = createChangeRequestRegistry([
  githubChangeRequestProvider
]);
