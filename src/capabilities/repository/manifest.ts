import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  localToolRegistrations
} from "../../core/tools/local-tool-registration.js";
import { repositoryToolCatalog } from "./tool-catalog.js";

export const manifest = capabilityManifest({
  id: "repository",
  kind: "execution",
  version: "2026.07.13",
  tools: localToolRegistrations(repositoryToolCatalog),
  docs: [{ title: "Repository local tools" }]
});
