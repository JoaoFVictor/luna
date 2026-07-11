import path from "node:path";
import { loadYamlFile } from "../../../core/config/loader.js";
import { RepositoriesConfigSchema } from "../../../core/config/schemas.js";
import { resolveRepository } from "../../../core/workflow/workspace-resolver.js";
import {
  createRunGraphSnapshotHandle
} from "../../application/runs/graph-snapshot.js";
import {
  studioRunDigestsEqual,
  studioRunValueDigest
} from "../../application/runs/launch-digests.js";
import { studioRunLaunchError } from "../../application/runs/launch-errors.js";
import type { StudioRunDispatchCommand } from "../../application/runs/launch-ports.js";
import type { PreallocateRunInput } from "../../application/runs/ports.js";
import { PreallocateRunInputSchema } from "../../application/runs/ports.js";
import type {
  NativeStudioQueuedRun,
  NativeStudioQueuedRunMaterial
} from "../filesystem/run-dispatch-contracts.js";
import { nativeStudioRunSnapshotManifest } from "./run-definition-snapshot.js";
import { fingerprintNativeStudioRepository } from "./run-repository-fingerprint.js";
import type { NativeStudioRunDispatchPayload } from "./run-snapshot-contracts.js";

function sideEffects(
  command: StudioRunDispatchCommand<NativeStudioRunDispatchPayload>
): PreallocateRunInput["side_effects"] {
  return [
    ...command.resolution.potential_effects.map((effect) => ({
      stage: "potential" as const,
      ...effect
    })),
    ...command.resolution.resolved_effects.map((effect) => ({
      stage: "resolved" as const,
      ...effect
    })),
    ...command.resolution.effect_uncertainties.map((uncertainty) => ({
      stage: "uncertainty" as const,
      ...uncertainty
    }))
  ];
}

export function nativeStudioRunDispatchIdentity(
  command: StudioRunDispatchCommand<NativeStudioRunDispatchPayload>
): { readonly runId: string; readonly bindingHash: string } {
  const bindingHash = studioRunValueDigest({
    schema_version: 1,
    idempotency_key_digest: command.idempotencyKeyDigest,
    actor_binding_digest: command.confirmation.actorBindingDigest,
    execution_snapshot_hash: command.snapshot.execution_snapshot_hash
  });
  return {
    runId: `studio-${bindingHash.slice("sha256:".length)}`,
    bindingHash
  };
}

export function buildNativeStudioQueuedRunMaterial(
  command: StudioRunDispatchCommand<NativeStudioRunDispatchPayload>
): NativeStudioQueuedRunMaterial {
  const { runId, bindingHash } = nativeStudioRunDispatchIdentity(command);
  const target = { type: "workflow" as const, id: command.request.workflow_id };
  const transitionId = `allocate-${runId}`;
  const eventId = `event-${transitionId}`;
  const graphSnapshotHandle = createRunGraphSnapshotHandle();
  const subject = command.request.invocation.subject;
  const preallocation = PreallocateRunInputSchema.parse({
    transition_id: transitionId,
    event_id: eventId,
    run_id: runId,
    accepted_plan_id: command.planId,
    input_provenance: command.request.input_provenance,
    workflow_id: command.request.workflow_id,
    definition: {
      workflow_revision: command.snapshot.workflow_revision,
      definition_bundle_hash: command.snapshot.definition_bundle_hash,
      catalog_fingerprint: command.snapshot.catalog_fingerprint,
      execution_snapshot_hash: command.snapshot.execution_snapshot_hash
    },
    created_at: command.requestedAt,
    source: command.request.invocation.source,
    ...(subject === undefined
      ? {}
      : {
          subject: {
            id: subject.id,
            ...(subject.title === undefined ? {} : { title: subject.title }),
            ...(subject.url === undefined ? {} : { url: subject.url })
          }
        }),
    ...(command.snapshot.repository_id === undefined
      ? {}
      : { repository_id: command.snapshot.repository_id }),
    graph_snapshot_handle: graphSnapshotHandle,
    side_effects: sideEffects(command)
  });
  return {
    schema_version: 1,
    run_id: runId,
    accepted_plan_id: command.planId,
    accepted_at: command.requestedAt,
    idempotency_binding_hash: bindingHash,
    execution_snapshot_hash: command.snapshot.execution_snapshot_hash,
    execution_snapshot: command.snapshot,
    catalog_fingerprint: command.snapshot.catalog_fingerprint,
    request: command.request,
    run: {
      run_id: runId,
      workflow_id: command.request.workflow_id,
      attempt: 1,
      started_at: command.requestedAt,
      source: command.request.invocation.source,
      event: command.request.invocation.event,
      ...(command.request.invocation.action === undefined
        ? {}
        : { action: command.request.invocation.action }),
      route_target: target
    },
    preallocation,
    snapshot: nativeStudioRunSnapshotManifest(command.dispatchPayload.snapshot)
  };
}

export async function verifyPinnedNativeStudioRepository(
  job: NativeStudioQueuedRun,
  definitionRoots: {
    readonly projectRoot: string;
    readonly configRoot: string;
  },
  signal?: AbortSignal
): Promise<void> {
  if (!job.execution_snapshot.repository_required) {
    return;
  }
  const repositories = await loadYamlFile(
    path.join(definitionRoots.configRoot, "repositories.yaml"),
    RepositoriesConfigSchema
  );
  const repository = resolveRepository(
    job.request.invocation,
    repositories.repositories
  );
  const expectedId = job.execution_snapshot.repository_id;
  const expectedFingerprint = job.execution_snapshot.repository_fingerprint;
  if (
    expectedId === undefined ||
    expectedFingerprint === undefined ||
    repository.id !== expectedId ||
    !studioRunDigestsEqual(
      await fingerprintNativeStudioRepository(repository, { signal }),
      expectedFingerprint
    )
  ) {
    throw studioRunLaunchError(
      "studio_run_dispatch_failed",
      "Pinned repository state changed before native runtime start"
    );
  }
}
