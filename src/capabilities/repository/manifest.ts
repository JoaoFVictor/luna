import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  localToolRegistrations
} from "../../core/tools/local-tool-registration.js";
import { repositoryLocalToolContracts } from "../../core/tools/repository-contracts.js";

export const manifest = capabilityManifest({
  id: "repository",
  kind: "execution",
  version: "2026.06.25",
  tools: localToolRegistrations(repositoryLocalToolContracts),
  docs: [{ title: "Repository read-only local tools" }]
});
