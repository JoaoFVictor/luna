import { manifest as agentsManifest } from "./agents/manifest.js";
import { manifest as artifactsManifest } from "./artifacts/manifest.js";
import { manifest as changeRequestManifest } from "./change-request/manifest.js";
import { manifest as contextManifest } from "./context/manifest.js";
import { manifest as findingsManifest } from "./findings/manifest.js";
import { manifest as gitManifest } from "./git/manifest.js";
import { manifest as localExecManifest } from "./local-exec/manifest.js";
import { manifest as qualityGatesManifest } from "./quality-gates/manifest.js";
import { manifest as repositoryManifest } from "./repository/manifest.js";
import { manifest as repositoryDiffManifest } from "./repository-diff/manifest.js";
import { manifest as reportsManifest } from "./reports/manifest.js";
import { manifest as repositoryWorkspaceManifest } from "./repository-workspace/manifest.js";
import { manifest as repositoryWriteManifest } from "./repository-write/manifest.js";
import { manifest as runtimeManifest } from "./runtime/manifest.js";
import { manifest as taskContextManifest } from "./task-context/manifest.js";
import { manifest as validationManifest } from "./validation/manifest.js";
import { manifest as repositoryChangeManifest } from "./repository-change/manifest.js";
import { createCapabilityRegistry } from "../core/capabilities/registry.js";

export const officialCapabilityManifests = Object.freeze([
  agentsManifest,
  artifactsManifest,
  contextManifest,
  runtimeManifest,
  repositoryDiffManifest,
  findingsManifest,
  reportsManifest,
  qualityGatesManifest,
  validationManifest,
  repositoryChangeManifest,
  taskContextManifest,
  repositoryManifest,
  localExecManifest,
  repositoryWorkspaceManifest,
  gitManifest,
  changeRequestManifest,
  repositoryWriteManifest
] as const);

export const officialCapabilityRegistry = createCapabilityRegistry(
  officialCapabilityManifests
);
