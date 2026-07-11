import type { StudioChangeSet } from "../../contracts/drafts.js";
import {
  STUDIO_VALIDATION_CAPABILITY_MAX_LENGTH,
  STUDIO_VALIDATION_FIELD_PATH_MAX_LENGTH,
  StudioDraftValidationResultSchema,
  StudioResourceValidationSchema,
  StudioValidationDiagnosticSchema,
  type StudioDraftValidationResult,
  type StudioResourceValidation,
  type StudioValidationDiagnostic
} from "../../contracts/validation.js";
import {
  StudioCanonicalDefinitionError,
  type StudioCanonicalDefinitionValidationPort
} from "./definition-validation.js";
import {
  StudioSnapshotCleanupAggregateError,
  type StudioValidationSnapshot,
  type StudioValidationSnapshotPort
} from "./snapshot.js";

export type ValidateStudioDraftOptions = {
  readonly compile?: boolean;
};

export type StudioDraftValidationServiceOptions = {
  readonly snapshots: StudioValidationSnapshotPort;
  readonly definitions: StudioCanonicalDefinitionValidationPort;
  readonly now?: () => Date;
};

function boundedSemanticLocation(
  value: string | undefined,
  maximumLength: number
): string | undefined {
  return value !== undefined &&
    value.length > 0 &&
    value.length <= maximumLength
    ? value
    : undefined;
}

function canonicalErrorDiagnostic(
  error: StudioCanonicalDefinitionError,
  resource: StudioChangeSet["resources"][number]
): StudioValidationDiagnostic {
  const fieldPath = boundedSemanticLocation(
    error.fieldPath,
    STUDIO_VALIDATION_FIELD_PATH_MAX_LENGTH
  );
  const capability = boundedSemanticLocation(
    error.capability,
    STUDIO_VALIDATION_CAPABILITY_MAX_LENGTH
  );
  return StudioValidationDiagnosticSchema.parse({
    severity: "error",
    code: error.code,
    message: error.message,
    resource,
    ...(fieldPath === undefined ? {} : { field_path: fieldPath }),
    ...(capability === undefined ? {} : { capability }),
    ...(error.nodeId === undefined ? {} : { node_id: error.nodeId }),
    ...(error.edge === undefined ? {} : { edge: error.edge })
  });
}

async function withSnapshotCleanup<T>(
  snapshot: StudioValidationSnapshot,
  operation: () => Promise<T>
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (operationCause) {
    try {
      await snapshot.dispose();
    } catch (cleanupCause) {
      throw new StudioSnapshotCleanupAggregateError(
        "Studio validation failed and its snapshot cleanup also failed",
        operationCause,
        cleanupCause
      );
    }
    throw operationCause;
  }
  await snapshot.dispose();
  return result;
}

export class StudioDraftValidationService {
  private readonly snapshots: StudioValidationSnapshotPort;
  private readonly definitions: StudioCanonicalDefinitionValidationPort;
  private readonly now: () => Date;

  constructor(options: StudioDraftValidationServiceOptions) {
    this.snapshots = options.snapshots;
    this.definitions = options.definitions;
    this.now = options.now ?? (() => new Date());
  }

  async validate(
    changeSet: StudioChangeSet,
    options: ValidateStudioDraftOptions = {}
  ): Promise<StudioDraftValidationResult> {
    const compile = options.compile ?? false;
    const snapshot = await this.snapshots.create(changeSet);
    return await withSnapshotCleanup(snapshot, async () => {
      const resources: StudioResourceValidation[] = [];
      for (const resource of changeSet.resources) {
        try {
          const validated = await this.definitions.validate({
            snapshot,
            resource,
            compile
          });
          resources.push(
            StudioResourceValidationSchema.parse({
              resource,
              status: "valid",
              revision: validated.revision,
              diagnostics: validated.diagnostics ?? [],
              ...(validated.compiledWorkflow === undefined
                ? {}
                : { compiled_workflow: validated.compiledWorkflow })
            })
          );
        } catch (cause) {
          if (!(cause instanceof StudioCanonicalDefinitionError)) {
            throw cause;
          }
          const diagnostic = canonicalErrorDiagnostic(cause, resource);
          resources.push(
            StudioResourceValidationSchema.parse({
              resource,
              status: "invalid",
              diagnostics: [diagnostic]
            })
          );
        }
      }

      const diagnostics = resources.flatMap(
        (resource) => resource.diagnostics
      );
      return StudioDraftValidationResultSchema.parse({
        draft_id: changeSet.draft_id,
        record_revision: changeSet.record_revision,
        content_revision: changeSet.content_revision,
        layout_revision: changeSet.layout_revision,
        draft_hash: changeSet.draft_hash,
        status: resources.some((resource) => resource.status === "invalid")
          ? "invalid"
          : "valid",
        compiled: compile,
        resources,
        diagnostics,
        validated_at: this.now().toISOString()
      });
    });
  }
}
