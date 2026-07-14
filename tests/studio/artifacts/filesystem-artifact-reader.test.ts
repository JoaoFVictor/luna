import { createHash } from "node:crypto";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ArtifactManifest } from "../../../src/core/runtime/artifacts/contracts.js";
import { createFilesystemArtifactManifestStore } from "../../../src/runtime/backends/filesystem/artifacts.js";
import { createFilesystemArtifactReader } from "../../../src/studio/adapters/filesystem/artifact-reader.js";

const RUN_ID = "run-artifacts-1";
const HANDLE_KEY = Buffer.alloc(32, 0x41);

function contentHash(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function withArtifacts(
  operation: (fixture: {
    readonly root: string;
    readonly outside: string;
    readonly put: (input: {
      readonly artifactPath: string;
      readonly content?: string | Uint8Array;
      readonly mediaType?: string;
      readonly semanticType?: string;
      readonly status?: ArtifactManifest["status"];
      readonly contentHash?: string;
      readonly writeContent?: boolean;
    }) => Promise<ArtifactManifest>;
    readonly reader: ReturnType<typeof createFilesystemArtifactReader>;
    readonly manifests: ReturnType<typeof createFilesystemArtifactManifestStore>;
  }) => Promise<void>,
  readerOptions: Partial<Parameters<typeof createFilesystemArtifactReader>[0]> = {}
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-artifacts-"));
  const outside = await mkdtemp(path.join(tmpdir(), "luna-studio-outside-"));
  const manifests = createFilesystemArtifactManifestStore({ root });
  const reader = createFilesystemArtifactReader({
    root,
    manifests,
    handleKey: HANDLE_KEY,
    ...readerOptions
  });

  async function put(input: {
    readonly artifactPath: string;
    readonly content?: string | Uint8Array;
    readonly mediaType?: string;
    readonly semanticType?: string;
    readonly status?: ArtifactManifest["status"];
    readonly contentHash?: string;
    readonly writeContent?: boolean;
  }): Promise<ArtifactManifest> {
    const content = input.content ?? "artifact content";
    if (input.writeContent !== false) {
      const target = path.join(root, RUN_ID, ...input.artifactPath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const manifest: ArtifactManifest = {
      id: input.artifactPath,
      run_id: RUN_ID,
      uri: `file:///private/root/${RUN_ID}/${input.artifactPath}`,
      backend_id: "filesystem.artifacts",
      backend_root: "/private/root/that-must-not-leak",
      source_node_id: "review",
      media_type: input.mediaType ?? "text/plain",
      ...(input.semanticType === undefined
        ? {}
        : { semantic_type: input.semanticType }),
      content_hash: input.contentHash ?? contentHash(content),
      artifact_path: input.artifactPath,
      status: input.status ?? "committed",
      attempt: 2,
      created_at: "2026-07-11T12:00:00.000Z"
    };
    await manifests.put(manifest);
    return manifest;
  }

  try {
    await operation({ root, outside, put, reader, manifests });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

describe("filesystem Studio artifact reader", () => {
  it("resolves only exact runtime artifact references and preserves reference order", async () => {
    await withArtifacts(async ({ put, reader }) => {
      const first = await put({ artifactPath: "reviews/first.json" });
      const second = await put({ artifactPath: "reviews/second.json" });
      const forged = { ...second, uri: `${second.uri}-forged` };

      const resolution = await reader.resolveReferences(RUN_ID, [
        { id: second.id, uri: second.uri, node_id: second.source_node_id },
        { id: first.id, uri: first.uri, node_id: first.source_node_id },
        { id: forged.id, uri: forged.uri, node_id: forged.source_node_id }
      ]);

      expect(resolution.matches.flatMap((match) =>
        match.status === "resolved" ? [match.artifact.name] : []
      )).toEqual([
        "second.json",
        "first.json"
      ]);
      expect(resolution.matches[2]).toEqual({ status: "unresolved" });
    });
  });

  it("rejects ambiguous runtime references instead of guessing a manifest by time", async () => {
    await withArtifacts(async ({ put, reader, manifests }) => {
      const manifest = await put({ artifactPath: "reviews/reused.json" });
      await manifests.put({ ...manifest, attempt: 3 });

      await expect(reader.resolveReferences(RUN_ID, [{
        id: manifest.id,
        uri: manifest.uri,
        node_id: manifest.source_node_id
      }])).rejects.toMatchObject({ code: "artifact_catalog_corrupt" });
    });
  });

  it("lists opaque metadata, redacts structured previews, and streams raw downloads", async () => {
    await withArtifacts(async ({ put, reader }) => {
      const content = JSON.stringify({
        api_token: "top-secret-value",
        nested: { note: "Authorization: Bearer abc.def.ghi" },
        public_count: 2
      });
      await put({
        artifactPath: "reports/private-result.json",
        content,
        mediaType: "application/json"
      });

      const listed = await reader.list(RUN_ID);
      expect(listed.items).toHaveLength(1);
      const item = listed.items[0];
      expect(item?.manifest_handle).toMatch(/^ah_[A-Za-z0-9_-]{43}$/);
      expect(item?.name).toBe("private-result.json");
      expect(JSON.stringify(listed)).not.toContain("/private/root");
      expect(JSON.stringify(listed)).not.toContain("reports/private-result.json");
      expect(item).not.toHaveProperty("uri");
      expect(item).not.toHaveProperty("backend_root");
      expect(item).not.toHaveProperty("artifact_path");

      const handle = item?.manifest_handle;
      if (handle === undefined) {
        throw new Error("Expected artifact handle");
      }
      const preview = await reader.preview({
        run_id: RUN_ID,
        manifest_handle: handle
      });
      expect(preview).toMatchObject({
        kind: "json",
        value: {
          api_token: "[REDACTED]",
          nested: { note: "Authorization: Bearer [REDACTED]" },
          public_count: 2
        },
        redaction: { mode: "best_effort", changed: true },
        render_policy: "structured_data_only"
      });

      const download = await reader.openDownload(RUN_ID, handle);
      expect(download).toMatchObject({
        disposition: "attachment",
        redaction: "not_applied",
        metadata: { raw_download_redaction: "not_applied" }
      });
      await expect(collect(download.body)).resolves.toEqual(Buffer.from(content));
    });
  });

  it("projects semantic metadata without exposing physical manifest fields", async () => {
    await withArtifacts(async ({ put, reader }) => {
      await put({
        artifactPath: "review/findings.json",
        content: '{"findings":[]}',
        mediaType: "application/json",
        semanticType: "luna.review.findings.v1"
      });

      const item = (await reader.list(RUN_ID)).items[0];
      expect(item).toMatchObject({ semantic_type: "luna.review.findings.v1" });
      expect(JSON.stringify(item)).not.toContain("/private/root");
      if (item === undefined) throw new Error("Expected artifact");
      await expect(
        reader.metadata(RUN_ID, item.manifest_handle)
      ).resolves.toMatchObject({ semantic_type: "luna.review.findings.v1" });
    });
  });

  it("truncates UTF-8 previews without emitting a replacement code point", async () => {
    await withArtifacts(async ({ put, reader }) => {
      await put({ artifactPath: "unicode.txt", content: "abc🙂def" });
      const handle = (await reader.list(RUN_ID)).items[0]?.manifest_handle;
      if (handle === undefined) {
        throw new Error("Expected artifact handle");
      }
      const preview = await reader.preview({
        run_id: RUN_ID,
        manifest_handle: handle,
        max_bytes: 5
      });
      expect(preview).toMatchObject({
        kind: "text",
        text: "abc",
        inspected_bytes: 5,
        truncated: true
      });
      expect(preview.kind === "text" ? preview.text : "").not.toContain("�");
    }, { maxPreviewBytes: 8 });
  });

  it("redacts JSON-looking secrets even when a truncated preview cannot be parsed", async () => {
    await withArtifacts(async ({ put, reader }) => {
      await put({
        artifactPath: "truncated.json",
        content: '{"api_token":"secret-value","padding":"xxxxxxxxxxxxxxxx"}',
        mediaType: "application/json"
      });
      const handle = (await reader.list(RUN_ID)).items[0]?.manifest_handle;
      if (handle === undefined) {
        throw new Error("Expected artifact handle");
      }
      const preview = await reader.preview({
        run_id: RUN_ID,
        manifest_handle: handle,
        max_bytes: 36
      });
      expect(preview).toMatchObject({
        kind: "text",
        truncated: true,
        redaction: { mode: "best_effort", changed: true }
      });
      expect(preview.kind === "text" ? preview.text : "").toContain(
        '"api_token":"[REDACTED]"'
      );
      expect(JSON.stringify(preview)).not.toContain("secret-value");
    }, { maxPreviewBytes: 64 });
  });

  it("classifies NUL and invalid UTF-8 as binary without returning content", async () => {
    await withArtifacts(async ({ put, reader }) => {
      await put({
        artifactPath: "payload.bin",
        content: new Uint8Array([0x66, 0x6f, 0x00, 0xff]),
        mediaType: "application/octet-stream"
      });
      const handle = (await reader.list(RUN_ID)).items[0]?.manifest_handle;
      if (handle === undefined) {
        throw new Error("Expected artifact handle");
      }
      const preview = await reader.preview({
        run_id: RUN_ID,
        manifest_handle: handle
      });
      expect(preview).toMatchObject({
        kind: "binary",
        reason: "binary_content",
        render_policy: "download_only"
      });
      expect(preview).not.toHaveProperty("text");
      expect(preview).not.toHaveProperty("value");
    });
  });

  it("never returns active HTML or SVG content through preview", async () => {
    await withArtifacts(async ({ put, reader }) => {
      await put({
        artifactPath: "report.html",
        content: "<script>globalThis.pwned = true</script>",
        mediaType: "text/html"
      });
      const item = (await reader.list(RUN_ID)).items[0];
      expect(item?.preview_capability).toBe("download_only");
      if (item === undefined) {
        throw new Error("Expected artifact");
      }
      const preview = await reader.preview({
        run_id: RUN_ID,
        manifest_handle: item.manifest_handle
      });
      expect(preview).toMatchObject({
        kind: "download_only",
        inspected_bytes: 0,
        reason: "active_content",
        render_policy: "download_only"
      });
      expect(JSON.stringify(preview)).not.toContain("globalThis.pwned");
    });
  });

  it("rejects traversal in run ids and forged manifests without leaking paths", async () => {
    await withArtifacts(async ({ manifests, reader, root }) => {
      await expect(reader.list("../outside")).rejects.toMatchObject({
        code: "artifact_input_invalid"
      });

      await manifests.put({
        id: "escape",
        run_id: RUN_ID,
        uri: "file:///etc/passwd",
        backend_id: "filesystem.artifacts",
        backend_root: root,
        artifact_path: "../outside/secret.txt",
        status: "committed",
        created_at: "2026-07-11T12:00:00.000Z"
      });
      const error = await reader.list(RUN_ID).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "artifact_security_violation" });
      expect(String((error as Error).message)).not.toContain(root);
      expect(JSON.stringify(error)).not.toContain("/etc/passwd");
      expect(JSON.stringify(error)).not.toContain("../outside");
    });
  });

  it.each([
    ".manifests/private.json",
    ".MaNiFeStS/private.json",
    ".pending/private.artifact",
    ".PENDING/private.artifact",
    "events.jsonl",
    "EVENTS.JSONL",
    "runtime.log.jsonl",
    "Runtime.Log.Jsonl",
    "runtime.log.jsonl/nested/private.json",
    "EVENTS.JSONL/nested/private.json",
    "trace.jsonl",
    "TRACE.JSONL",
    "trace.jsonl/nested/private.json"
  ])("rejects a forged manifest aimed at reserved storage: %s", async (artifactPath) => {
    await withArtifacts(async ({ manifests, reader, root }) => {
      await manifests.put({
        id: "metadata",
        run_id: RUN_ID,
        uri: "artifact://metadata",
        backend_id: "filesystem.artifacts",
        backend_root: root,
        artifact_path: artifactPath,
        status: "committed",
        created_at: "2026-07-11T12:00:00.000Z"
      });
      await expect(reader.list(RUN_ID)).rejects.toMatchObject({
        code: "artifact_security_violation"
      });
    });
  });

  it("rejects symlink files and symlink ancestors even when their targets exist", async () => {
    await withArtifacts(async ({ root, outside, put, reader }) => {
      await mkdir(path.join(root, RUN_ID), { recursive: true });
      const outsideFile = path.join(outside, "secret.txt");
      await writeFile(outsideFile, "outside secret");
      await symlink(outsideFile, path.join(root, RUN_ID, "linked.txt"));
      await put({
        artifactPath: "linked.txt",
        content: "outside secret",
        writeContent: false
      });
      const first = (await reader.list(RUN_ID)).items[0];
      if (first === undefined) {
        throw new Error("Expected artifact");
      }
      await expect(reader.preview({
        run_id: RUN_ID,
        manifest_handle: first.manifest_handle
      })).rejects.toMatchObject({ code: "artifact_security_violation" });

      await symlink(outside, path.join(root, RUN_ID, "linked-dir"), "dir");
      await put({
        artifactPath: "linked-dir/secret.txt",
        content: "outside secret",
        writeContent: false
      });
      const second = (await reader.list(RUN_ID)).items.find(
        (item) => item.name === "secret.txt"
      );
      if (second === undefined) {
        throw new Error("Expected nested artifact");
      }
      await expect(reader.metadata(RUN_ID, second.manifest_handle)).rejects.toMatchObject({
        code: "artifact_security_violation"
      });
    });
  });

  it("binds handles to the run and rejects tampering and unavailable manifests", async () => {
    await withArtifacts(async ({ put, reader }) => {
      await put({ artifactPath: "pending.txt", status: "pending" });
      const item = (await reader.list(RUN_ID)).items[0];
      if (item === undefined) {
        throw new Error("Expected artifact");
      }
      await expect(reader.metadata(RUN_ID, item.manifest_handle)).rejects.toMatchObject({
        code: "artifact_unavailable"
      });
      await expect(reader.metadata("another-run", item.manifest_handle)).rejects.toMatchObject({
        code: "artifact_not_found"
      });
      const replacement = item.manifest_handle.endsWith("A") ? "B" : "A";
      const tampered = `${item.manifest_handle.slice(0, -1)}${replacement}`;
      await expect(reader.metadata(RUN_ID, tampered)).rejects.toMatchObject({
        code: "artifact_not_found"
      });
      await expect(reader.metadata(RUN_ID, "../../etc/passwd" as never)).rejects.toMatchObject({
        code: "artifact_handle_invalid"
      });
    });
  });

  it("enforces artifact size and verifies the manifest hash while streaming", async () => {
    await withArtifacts(async ({ put, reader }) => {
      await put({ artifactPath: "large.txt", content: "x".repeat(33) });
      const item = (await reader.list(RUN_ID)).items[0];
      if (item === undefined) {
        throw new Error("Expected artifact");
      }
      await expect(reader.metadata(RUN_ID, item.manifest_handle)).rejects.toMatchObject({
        code: "artifact_too_large",
        details: { max_bytes: 32 }
      });
    }, { maxArtifactBytes: 32 });

    await withArtifacts(async ({ put, reader }) => {
      await put({
        artifactPath: "wrong-hash.txt",
        content: "actual content",
        contentHash: `sha256:${"0".repeat(64)}`
      });
      const item = (await reader.list(RUN_ID)).items[0];
      if (item === undefined) {
        throw new Error("Expected artifact");
      }
      const download = await reader.openDownload(RUN_ID, item.manifest_handle);
      await expect(reader.preview({
        run_id: RUN_ID,
        manifest_handle: item.manifest_handle
      })).rejects.toMatchObject({ code: "artifact_content_changed" });
      await expect(collect(download.body)).rejects.toMatchObject({
        code: "artifact_content_changed"
      });
    });
  });

  it("bounds the number of manifests exposed by one run", async () => {
    await withArtifacts(async ({ put, reader }) => {
      await put({ artifactPath: "one.txt" });
      await put({ artifactPath: "two.txt" });
      await expect(reader.list(RUN_ID)).rejects.toMatchObject({
        code: "artifact_too_large",
        details: { max_artifacts: 1 }
      });
    }, { maxArtifactsPerRun: 1 });
  });

  it("maps origin manifest byte limits without materializing oversized metadata", async () => {
    await withArtifacts(async ({ manifests, reader }) => {
      await manifests.put({
        id: "oversized-manifest",
        run_id: RUN_ID,
        uri: `artifact://${RUN_ID}/${"x".repeat(1_024)}`,
        backend_id: "filesystem.artifacts",
        artifact_path: "result.txt",
        status: "committed",
        created_at: "2026-07-11T12:00:00.000Z"
      });
      await expect(reader.list(RUN_ID)).rejects.toMatchObject({
        code: "artifact_too_large",
        details: { max_manifest_bytes: 256 }
      });
    }, {
      maxManifestBytes: 256,
      maxManifestTotalBytes: 4_096
    });
  });
});
