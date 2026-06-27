import { defineInputAdapters } from "../adapters/registry.js";
import { githubPrUrlAdapter } from "../adapters/github-pr-url/index.js";
import { jiraTaskUrlAdapter } from "../adapters/jira-task-url/index.js";
import { planeTaskUrlAdapter } from "../adapters/plane-task-url/index.js";

export const nativeInputAdapterRegistry = defineInputAdapters([
  githubPrUrlAdapter,
  jiraTaskUrlAdapter,
  planeTaskUrlAdapter
]);
