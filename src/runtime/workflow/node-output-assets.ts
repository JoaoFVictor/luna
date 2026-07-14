import {
  NodeBinaryAssetChannelSchema,
  type BinaryAssetRef,
  type NodeBinaryAssetChannel
} from "../../core/runtime/artifacts/binary-asset.js";
import { runtimeError } from "../../core/runtime/errors.js";
import type { RuntimeArtifactRef } from "../../core/runtime/state.js";
import type { WorkflowArtifactPublisherPort } from "../../core/workflow/execution-contracts.js";

/**
 * Resolves the explicit binary-asset channel emitted by a node.
 *
 * Produced refs must belong to the physical execution node and be committed
 * by the artifact authority. Forwarded refs are never re-adopted: they must
 * already be present in the trusted runtime state supplied by the caller.
 */
export async function committedBinaryAssetRefs(
  channel: NodeBinaryAssetChannel | undefined,
  nodeId: string,
  trustedRefs: readonly RuntimeArtifactRef[],
  publisher: WorkflowArtifactPublisherPort | undefined
): Promise<RuntimeArtifactRef[]> {
  if (channel === undefined) return [];
  const parsed = NodeBinaryAssetChannelSchema.safeParse(channel);
  if (!parsed.success) {
    throw invalidAssetChannel(nodeId, "Node returned an invalid binary asset channel");
  }

  const trustedKeys = new Set(trustedRefs.map(refKey));
  const selected = new Map<string, {
    readonly ownership: "produced" | "forwarded";
    readonly asset: BinaryAssetRef;
    readonly ref: RuntimeArtifactRef;
  }>();

  for (const asset of parsed.data.produced) {
    if (asset.node_id !== nodeId) {
      throw invalidAssetChannel(
        nodeId,
        "Produced binary asset belongs to a different execution node",
        asset
      );
    }
    await selectAsset({
      asset,
      ownership: "produced",
      nodeId,
      publisher,
      selected,
      trustedKeys
    });
  }

  for (const asset of parsed.data.forwarded) {
    const key = refKey(asset);
    if (!trustedKeys.has(key)) {
      throw invalidAssetChannel(
        nodeId,
        "Forwarded binary asset is not present in trusted runtime state",
        asset
      );
    }
    await selectAsset({
      asset,
      ownership: "forwarded",
      nodeId,
      publisher,
      selected,
      trustedKeys
    });
  }

  return [...selected.values()].map(({ ref }) => ref);
}

async function selectAsset({
  asset,
  ownership,
  nodeId,
  publisher,
  selected,
  trustedKeys
}: {
  readonly asset: BinaryAssetRef;
  readonly ownership: "produced" | "forwarded";
  readonly nodeId: string;
  readonly publisher: WorkflowArtifactPublisherPort | undefined;
  readonly selected: Map<string, {
    readonly ownership: "produced" | "forwarded";
    readonly asset: BinaryAssetRef;
    readonly ref: RuntimeArtifactRef;
  }>;
  readonly trustedKeys: ReadonlySet<string>;
}): Promise<void> {
  const ref = { id: asset.id, uri: asset.uri, node_id: asset.node_id };
  const key = refKey(ref);
  const previous = selected.get(key);
  if (previous !== undefined) {
    if (
      previous.ownership !== ownership ||
      previous.asset.media_type !== asset.media_type ||
      previous.asset.content_hash !== asset.content_hash ||
      previous.asset.size_bytes !== asset.size_bytes
    ) {
      throw invalidAssetChannel(
        nodeId,
        "Binary asset channel contains conflicting references",
        asset
      );
    }
    return;
  }

  if (
    ownership === "produced" &&
    !trustedKeys.has(key) &&
    (publisher?.verify === undefined || !(await publisher.verify(asset)))
  ) {
    throw invalidAssetChannel(
      nodeId,
      "Node returned a produced binary asset that is not committed",
      asset
    );
  }
  selected.set(key, { ownership, asset, ref });
}

function invalidAssetChannel(
  nodeId: string,
  message: string,
  asset?: Pick<BinaryAssetRef, "id" | "node_id">
): ReturnType<typeof runtimeError> {
  return runtimeError(message, "runtime_state_invalid", {
    details: {
      node_id: nodeId,
      ...(asset === undefined
        ? {}
        : { asset_id: asset.id, asset_node_id: asset.node_id })
    }
  });
}

function refKey(ref: RuntimeArtifactRef): string {
  return `${ref.id}\u0000${ref.uri}\u0000${ref.node_id ?? ""}`;
}
