import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ArtifactStore } from "../../src/core/artifact-store.js";
import { runStructuredNode } from "../../src/core/structured-node.js";

const OutputSchema = z
  .object({
    ok: z.boolean(),
    message: z.string()
  })
  .strict();

async function tempRoot(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "luna-structured-node-")));
}

describe("structured node execution", () => {
  it("returns parsed output from a valid first attempt", async () => {
    const artifactStore = new ArtifactStore(await tempRoot(), "run-a1");

    const result = await runStructuredNode({
      nodeName: "reviewer",
      schema: OutputSchema,
      artifactStore,
      execute: async () => "{\"ok\":true,\"message\":\"accepted\"}"
    });

    expect(result).toEqual({ ok: true, message: "accepted" });
  });

  it("retries once after an invalid first attempt and returns a valid second output", async () => {
    const artifactStore = new ArtifactStore(await tempRoot(), "run-a1");
    let attempts = 0;

    const result = await runStructuredNode({
      nodeName: "reviewer",
      schema: OutputSchema,
      artifactStore,
      execute: async () => {
        attempts += 1;
        return attempts === 1
          ? "{\"ok\":\"yes\",\"message\":\"wrong shape\"}"
          : "{\"ok\":true,\"message\":\"fixed\"}";
      }
    });

    expect(attempts).toBe(2);
    expect(result).toEqual({ ok: true, message: "fixed" });
  });

  it("writes invalid output after an invalid second attempt and throws agent_output_invalid", async () => {
    const root = await tempRoot();
    const artifactStore = new ArtifactStore(root, "run-a1");

    await expect(
      runStructuredNode({
        nodeName: "reviewer",
        schema: OutputSchema,
        artifactStore,
        execute: async () => "{\"ok\":123,\"message\":false}"
      })
    ).rejects.toThrow(expect.objectContaining({ code: "agent_output_invalid" }));

    const artifact = JSON.parse(
      await readFile(join(root, "run-a1", "invalid-output", "reviewer.json"), "utf8")
    );

    expect(artifact).toMatchObject({
      node: "reviewer",
      attempts: 2,
      raw_output: "{\"ok\":123,\"message\":false}"
    });
    expect(JSON.stringify(artifact.issues)).toContain("ok");
    expect(JSON.stringify(artifact.issues)).toContain("message");
  });

  it("redacts secrets and truncates large raw string output in invalid artifacts", async () => {
    const root = await tempRoot();
    const artifactStore = new ArtifactStore(root, "run-a1");
    const secretPrefix =
      "{\"api_key\":\"sk-live-secret\",\"password\":\"hunter2\",\"authorization\":\"Bearer abc123\",\"token=plain-secret\",\"ok\":";
    const oversizedOutput = `${secretPrefix}${"x".repeat(9000)}`;

    await expect(
      runStructuredNode({
        nodeName: "reviewer",
        schema: OutputSchema,
        artifactStore,
        execute: async () => oversizedOutput
      })
    ).rejects.toThrow(expect.objectContaining({ code: "agent_output_invalid" }));

    const artifact = JSON.parse(
      await readFile(join(root, "run-a1", "invalid-output", "reviewer.json"), "utf8")
    );

    expect(artifact.raw_output.length).toBeLessThanOrEqual(8192);
    expect(artifact.raw_output_truncated).toBe(true);
    expect(artifact.raw_output).not.toContain("sk-live-secret");
    expect(artifact.raw_output).not.toContain("hunter2");
    expect(artifact.raw_output).not.toContain("Bearer abc123");
    expect(artifact.raw_output).not.toContain("plain-secret");
    expect(artifact.raw_output).toContain("[REDACTED]");
  });

  it("uses a safe invalid-output filename while preserving the original node name", async () => {
    const root = await tempRoot();
    const artifactStore = new ArtifactStore(root, "run-a1");

    await expect(
      runStructuredNode({
        nodeName: "../Reviewer Node\\final",
        schema: OutputSchema,
        artifactStore,
        execute: async () => "{\"ok\":123,\"message\":false}"
      })
    ).rejects.toThrow(expect.objectContaining({ code: "agent_output_invalid" }));

    const artifact = JSON.parse(
      await readFile(
        join(root, "run-a1", "invalid-output", "reviewer-node-final.json"),
        "utf8"
      )
    );

    expect(artifact.node).toBe("../Reviewer Node\\final");
  });
});
