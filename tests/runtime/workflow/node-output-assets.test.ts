import { describe, expect, it, vi } from "vitest";
import type {
  BinaryAssetRef,
  NodeBinaryAssetChannel
} from "../../../src/core/runtime/artifacts/binary-asset.js";
import { committedBinaryAssetRefs } from "../../../src/runtime/workflow/node-output-assets.js";

const asset: BinaryAssetRef = {
  id: "generated.png",
  uri: "artifact://run/generated.png",
  node_id: "image",
  media_type: "image/png",
  content_hash: `sha256:${"a".repeat(64)}`,
  size_bytes: 42
};

function channel(
  produced: readonly BinaryAssetRef[] = [],
  forwarded: readonly BinaryAssetRef[] = []
): NodeBinaryAssetChannel {
  return { produced: [...produced], forwarded: [...forwarded] };
}

describe("node binary asset channel", () => {
  it("does not infer refs when no explicit channel was emitted", async () => {
    await expect(committedBinaryAssetRefs(
      undefined,
      "image",
      [],
      { publish: vi.fn(), verify: vi.fn(async () => true) }
    )).resolves.toEqual([]);
  });

  it("accepts a committed produced ref owned by the execution node", async () => {
    const verify = vi.fn(async () => true);

    await expect(committedBinaryAssetRefs(
      channel([asset]),
      "image",
      [],
      { publish: vi.fn(), verify }
    )).resolves.toEqual([{
      id: asset.id,
      uri: asset.uri,
      node_id: asset.node_id
    }]);
    expect(verify).toHaveBeenCalledWith(asset);
  });

  it("rejects a produced ref that is not committed", async () => {
    await expect(committedBinaryAssetRefs(
      channel([asset]),
      "image",
      [],
      { publish: vi.fn(), verify: vi.fn(async () => false) }
    )).rejects.toMatchObject({ code: "runtime_state_invalid" });
  });

  it("rejects a produced ref owned by a different execution node", async () => {
    const verify = vi.fn(async () => true);

    await expect(committedBinaryAssetRefs(
      channel([{ ...asset, node_id: "other-image" }]),
      "image",
      [],
      { publish: vi.fn(), verify }
    )).rejects.toMatchObject({
      code: "runtime_state_invalid",
      details: { node_id: "image", asset_node_id: "other-image" }
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("forwards only an exact ref already trusted by runtime state", async () => {
    const verify = vi.fn(async () => false);
    const trusted = { id: asset.id, uri: asset.uri, node_id: asset.node_id };

    await expect(committedBinaryAssetRefs(
      channel([], [asset]),
      "editorial",
      [trusted],
      { publish: vi.fn(), verify }
    )).resolves.toEqual([trusted]);
    expect(verify).not.toHaveBeenCalled();

    await expect(committedBinaryAssetRefs(
      channel([], [{ ...asset, uri: "artifact://run/untrusted.png" }]),
      "editorial",
      [trusted],
      { publish: vi.fn(), verify }
    )).rejects.toMatchObject({ code: "runtime_state_invalid" });
  });
});
