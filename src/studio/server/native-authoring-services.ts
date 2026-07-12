import type { LunaPlatform } from "../../platform/native/native-platform.js";
import { FileSystemStudioApplyJournal } from "../adapters/filesystem/apply-journal.js";
import {
  FileSystemStudioApplyTransaction
} from "../adapters/filesystem/apply-transaction.js";
import {
  FileSystemStudioApplySource,
  StudioApplyPathResolver
} from "../adapters/filesystem/apply-paths.js";
import { StudioApplyWorkspace } from "../adapters/filesystem/apply-workspace.js";
import { FileSystemStudioDraftRepository } from "../adapters/filesystem/draft-repository.js";
import { FileSystemStudioLockManager } from "../adapters/filesystem/studio-lock-manager.js";
import { FileSystemStudioValidationSnapshot } from "../adapters/filesystem/validation-snapshot.js";
import { MemoryStudioApplyPlanTokens } from "../adapters/memory/apply-plan-tokens.js";
import { NativeStudioDefinitionValidation } from "../adapters/native/definition-validation.js";
import { NativeStudioInstalledApplyVerifier } from "../adapters/native/installed-apply-verifier.js";
import { StudioApplyService } from "../application/apply/service.js";
import type { StudioDraftPersistencePort } from "../application/drafts/persistence.js";
import { StudioDraftValidationService } from "../application/validation/draft-validation.js";

const DEFAULT_APPLY_MAX_FILE_BYTES = 4 * 1024 * 1024;

type NativeAuthoringPlatform = Pick<
  LunaPlatform,
  "capabilityRegistry" | "capabilityManifests"
>;

export type NativeStudioAuthoringServicesOptions = {
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly platform: NativeAuthoringPlatform;
  readonly technicalCatalogFingerprint: () => Promise<string> | string;
  readonly applyMaxFileBytes?: number;
};

export type NativeStudioAuthoringServices = {
  readonly drafts: StudioDraftPersistencePort;
  readonly validation: StudioDraftValidationService;
  readonly apply: StudioApplyService;
  initialize(): Promise<void>;
};

export class StudioApplyRecoveryStartupError extends Error {
  readonly code = "studio_apply_recovery_incomplete" as const;
  readonly operationIds: readonly string[];

  constructor(operationIds: readonly string[]) {
    super("Studio apply recovery did not restore every pending operation");
    this.name = "StudioApplyRecoveryStartupError";
    this.operationIds = Object.freeze([...operationIds]);
  }
}

export async function requireStudioApplyRecovery(
  apply: Pick<StudioApplyService, "recover">
): Promise<void> {
  const recovery = await apply.recover();
  if (recovery.recoveryRequired.length > 0) {
    throw new StudioApplyRecoveryStartupError(
      recovery.recoveryRequired
    );
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function createNativeStudioAuthoringServices(
  options: NativeStudioAuthoringServicesOptions
): NativeStudioAuthoringServices {
  const maxFileBytes = positiveSafeInteger(
    options.applyMaxFileBytes ?? DEFAULT_APPLY_MAX_FILE_BYTES,
    "Studio apply max file bytes"
  );
  const lockManager = new FileSystemStudioLockManager({
    projectRoot: options.projectRoot
  });
  const drafts = new FileSystemStudioDraftRepository({
    projectRoot: options.projectRoot,
    lockManager
  });
  const definitions = new NativeStudioDefinitionValidation({
    platform: options.platform
  });
  const validation = new StudioDraftValidationService({
    snapshots: new FileSystemStudioValidationSnapshot({
      projectRoot: options.projectRoot,
      configRoot: options.configRoot,
      blobs: drafts
    }),
    definitions
  });
  const resolver = new StudioApplyPathResolver({
    project: options.projectRoot,
    config: options.configRoot
  });
  const source = new FileSystemStudioApplySource(resolver);
  const journal = new FileSystemStudioApplyJournal({
    projectRoot: options.projectRoot
  });
  const transactions = new FileSystemStudioApplyTransaction({
    journal,
    workspace: new StudioApplyWorkspace({
      resolver,
      source,
      maxFileBytes
    }),
    maxFileBytes
  });
  const installedVerifier = new NativeStudioInstalledApplyVerifier({
    projectRoot: options.projectRoot,
    configRoot: options.configRoot,
    definitions
  });
  const apply = new StudioApplyService({
    drafts,
    source,
    validation,
    planTokens: new MemoryStudioApplyPlanTokens(),
    transactions,
    lockManager,
    installedVerifier,
    technicalCatalogFingerprint: options.technicalCatalogFingerprint,
    limits: { maxFileBytes }
  });

  let initialized: Promise<void> | undefined;
  const initialize = async (): Promise<void> =>
    await requireStudioApplyRecovery(apply);

  return {
    drafts,
    validation,
    apply,
    initialize() {
      initialized ??= initialize();
      return initialized;
    }
  };
}
