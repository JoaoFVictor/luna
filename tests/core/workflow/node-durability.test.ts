import { describe, expect, it } from "vitest";
import type { NodeBinaryAssetChannel } from "../../../src/core/runtime/artifacts/binary-asset.js";
import { createMemoryArtifactManifestStore } from "../../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../../src/runtime/backends/memory/runtime-log.js";
import {
  NODE_OUTPUT_JOURNAL_CHANNEL,
  persistedNodeDurability,
  saveNodeOutputAt,
  type NodeDurabilityLocation
} from "../../../src/runtime/workflow/node-durability.js";

const location: NodeDurabilityLocation = {
  thread_id: "run-1",
  checkpoint_ns: "",
  checkpoint_id: "node-output-second",
  task_id: "second"
};

const binaryAssets: NodeBinaryAssetChannel = {
  produced: [
    {
      id: "asset-1",
      uri: "artifact://asset-1",
      node_id: "second",
      media_type: "image/png",
      content_hash: `sha256:${"a".repeat(64)}`,
      size_bytes: 42
    }
  ],
  forwarded: []
};

function backends() {
  return {
    artifacts: createMemoryArtifactManifestStore(),
    events: createMemoryEventStore(),
    interrupts: createMemoryInterruptStore(),
    checkpoints: createMemoryCheckpointStore(),
    runtimeLogs: createMemoryRuntimeLogStore()
  };
}

async function roundTrip(
  output: { readonly kind: "luna.node-output"; readonly body: string },
  assets?: NodeBinaryAssetChannel
) {
  const stores = backends();
  await saveNodeOutputAt({
    input: { backends: stores },
    location,
    output,
    ...(assets === undefined ? {} : { binaryAssets: assets })
  });
  const writes = await stores.checkpoints.listWrites(
    location.thread_id,
    location.checkpoint_ns,
    location.checkpoint_id
  );
  return {
    writes,
    durability: persistedNodeDurability({
      nodeId: location.task_id,
      writes
    })
  };
}

describe("persisted node durability", () => {
  it("round-trips a domain luna.node-output value without binary assets", async () => {
    const output = { kind: "luna.node-output", body: "domain value" } as const;

    const { writes, durability } = await roundTrip(output);

    expect(writes[0]?.channel).toBe(NODE_OUTPUT_JOURNAL_CHANNEL);
    expect(writes[0]?.value).toEqual({
      kind: "luna.runtime.node-output-envelope",
      schema_version: 2,
      output
    });
    expect(durability).toEqual({ kind: "output_pending", output });
  });

  it("round-trips a domain luna.node-output value with binary assets", async () => {
    const output = {
      kind: "luna.node-output",
      body: "domain asset value"
    } as const;

    const { writes, durability } = await roundTrip(output, binaryAssets);

    expect(writes[0]?.channel).toBe(NODE_OUTPUT_JOURNAL_CHANNEL);
    expect(writes[0]?.value).toEqual({
      kind: "luna.runtime.node-output-envelope",
      schema_version: 2,
      output,
      binary_assets: binaryAssets
    });
    expect(durability).toEqual({
      kind: "output_pending",
      output,
      binaryAssets
    });
  });

  it("round-trips domain output that exactly imitates the current envelope", async () => {
    const output = {
      kind: "luna.runtime.node-output-envelope",
      schema_version: 2,
      output: { nested: "domain value" },
      binary_assets: binaryAssets
    } as const;
    const stores = backends();

    await saveNodeOutputAt({
      input: { backends: stores },
      location,
      output
    });
    const writes = await stores.checkpoints.listWrites(
      location.thread_id,
      location.checkpoint_ns,
      location.checkpoint_id
    );

    expect(writes[0]?.channel).toBe(NODE_OUTPUT_JOURNAL_CHANNEL);
    expect(persistedNodeDurability({
      nodeId: location.task_id,
      writes
    })).toEqual({ kind: "output_pending", output });
  });

  it("rejects simultaneous legacy and current output channels", () => {
    expect(() => persistedNodeDurability({
      nodeId: location.task_id,
      writes: [
        {
          ...location,
          index: 0,
          channel: "steps",
          value: { legacy: true }
        },
        {
          ...location,
          index: 0,
          channel: NODE_OUTPUT_JOURNAL_CHANNEL,
          value: {
            kind: "luna.runtime.node-output-envelope",
            schema_version: 2,
            output: { current: true }
          }
        }
      ]
    })).toThrow(expect.objectContaining({ code: "runtime_state_invalid" }));
  });

  it("treats non-envelope legacy discriminator values as domain output", () => {
    const output = { kind: "luna.node-output", body: "legacy collision" };

    expect(persistedNodeDurability({
      nodeId: location.task_id,
      writes: [{
        ...location,
        index: 0,
        channel: "steps",
        value: output
      }]
    })).toEqual({ kind: "output_pending", output });
  });

  it("treats an exact envelope-shaped value on the old channel as domain output", () => {
    const output = {
      kind: "luna.node-output",
      schema_version: 1,
      output: { body: "domain value" },
      binary_assets: binaryAssets
    };

    expect(persistedNodeDurability({
      nodeId: location.task_id,
      writes: [{
        ...location,
        index: 0,
        channel: "steps",
        value: output
      }]
    })).toEqual({ kind: "output_pending", output });
  });

  it("rejects foreign writes inside a node-owned checkpoint", () => {
    expect(() =>
      persistedNodeDurability({
        nodeId: "second",
        writes: [
          {
            thread_id: "run-1",
            checkpoint_ns: "",
            checkpoint_id: "node-output-second",
            task_id: "second",
            index: 0,
            channel: "steps",
            value: { canonical: true }
          },
          {
            thread_id: "run-1",
            checkpoint_ns: "",
            checkpoint_id: "node-output-second",
            task_id: "first",
            index: 9,
            channel: "steps",
            value: { injected: true }
          }
        ]
      })
    ).toThrow(
      expect.objectContaining({
        code: "runtime_state_invalid",
        details: expect.objectContaining({
          node_id: "second",
          write_task_id: "first",
          write_index: 9,
          write_channel: "steps"
        })
      })
    );
  });
});
