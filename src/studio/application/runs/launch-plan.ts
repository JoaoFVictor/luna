import {
  StudioRunExecutionSnapshotSchema,
  StudioRunPlanResolutionSchema,
  type StudioRunExecutionSnapshot,
  type StudioRunPlanRequest,
  type StudioRunPlanResolution
} from "../../contracts/run-launch.js";
import { studioRunValueDigest } from "./launch-digests.js";
import { studioRunLaunchError } from "./launch-errors.js";

export function freezeStudioRunValue<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const pending: object[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const nested of Object.values(current)) {
      if (typeof nested === "object" && nested !== null) {
        pending.push(nested);
      }
    }
    Object.freeze(current);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeStudioRunResolution(
  value: StudioRunPlanResolution
): StudioRunPlanResolution {
  return StudioRunPlanResolutionSchema.parse({
    ...value,
    potential_effects: [...value.potential_effects].sort((left, right) =>
      compareText(left.effect_id, right.effect_id)
    ),
    resolved_effects: [...value.resolved_effects].sort((left, right) =>
      compareText(left.effect_id, right.effect_id)
    ),
    effect_uncertainties: [...value.effect_uncertainties].sort((left, right) =>
      compareText(left.uncertainty_id, right.uncertainty_id)
    ),
    warnings: [...value.warnings].sort((left, right) =>
      compareText(left.code, right.code)
    )
  });
}

export function assertStudioRunResolutionMatchesRequest(
  request: StudioRunPlanRequest,
  resolution: StudioRunPlanResolution
): void {
  if (resolution.workflow_id !== request.workflow_id) {
    throw studioRunLaunchError(
      "studio_run_plan_resolution_mismatch",
      "Resolved workflow does not match the requested workflow"
    );
  }
  if (
    request.repository_id !== undefined &&
    resolution.repository.repository_id !== request.repository_id
  ) {
    throw studioRunLaunchError(
      "studio_run_plan_resolution_mismatch",
      "Resolved repository does not match the requested repository"
    );
  }
}

export function createStudioRunExecutionSnapshot(
  request: StudioRunPlanRequest,
  resolution: StudioRunPlanResolution
): StudioRunExecutionSnapshot {
  const material = {
    schema_version: 1,
    workflow_id: resolution.workflow_id,
    mode: resolution.mode,
    workflow_revision: resolution.workflow_revision,
    definition_bundle_hash: resolution.definition_bundle_hash,
    catalog_fingerprint: resolution.catalog_fingerprint,
    invocation_hash: studioRunValueDigest(request.invocation),
    config_hash: studioRunValueDigest(request.config),
    repository_required: resolution.repository.required,
    ...(resolution.repository.repository_id === undefined
      ? {}
      : { repository_id: resolution.repository.repository_id }),
    ...(resolution.repository.fingerprint === undefined
      ? {}
      : { repository_fingerprint: resolution.repository.fingerprint }),
    input_provenance: request.input_provenance
  } as const;

  return StudioRunExecutionSnapshotSchema.parse({
    ...material,
    execution_snapshot_hash: studioRunValueDigest(material)
  });
}

export function studioRunStablePlanDigest(
  snapshot: StudioRunExecutionSnapshot,
  resolution: StudioRunPlanResolution,
  confirmationRequired: boolean
): string {
  return studioRunValueDigest({
    schema_version: 1,
    snapshot,
    potential_effects: resolution.potential_effects,
    resolved_effects: resolution.resolved_effects,
    effect_uncertainties: resolution.effect_uncertainties,
    warnings: resolution.warnings,
    confirmation_required: confirmationRequired
  });
}
