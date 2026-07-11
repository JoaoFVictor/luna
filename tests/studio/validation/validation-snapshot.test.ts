import { createHash } from "node:crypto";
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudioChangeSet } from "../../../src/studio/application/drafts/change-set.js";
import type { StudioDraftBlobReaderPort } from "../../../src/studio/application/drafts/persistence.js";
import { StudioSnapshotCleanupAggregateError } from "../../../src/studio/application/validation/snapshot.js";
import { FileSystemStudioValidationSnapshot } from "../../../src/studio/adapters/filesystem/validation-snapshot.js";
import type {
  StudioBaseFile,
  StudioChangeSet,
  StudioDependency,
  StudioDraftFileChange
} from "../../../src/studio/contracts/drafts.js";
import type { StudioPath } from "../../../src/studio/contracts/paths.js";

const DRAFT_ID = "00000000-0000-4000-8000-000000000010";
const temporaryDirectories: string[] = [];

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSource(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

class MemoryBlobStore implements StudioDraftBlobReaderPort {
  constructor(private readonly values: ReadonlyMap<string, string>) {}

  async getBlob(
    _draftId: string,
    reference: string,
    _options: { readonly maxBytes: number }
  ): Promise<string> {
    const value = this.values.get(reference);
    if (value === undefined) {
      throw new Error(`Missing test blob ${reference}`);
    }
    return value;
  }
}

type DraftFixture = {
  readonly draft: StudioChangeSet;
  readonly blobs: ReadonlyMap<string, string>;
};

function draftFixture(input: {
  readonly baseFiles: readonly StudioBaseFile[];
  readonly dependencies?: readonly StudioDependency[];
  readonly changes?: readonly StudioDraftFileChange[];
  readonly blobContents: readonly string[];
  readonly allowedFiles?: readonly StudioPath[];
}): DraftFixture {
  const blobs = new Map(
    input.blobContents.map((content) => [digest(content), content])
  );
  const allowedFiles =
    input.allowedFiles ?? input.baseFiles.map((entry) => entry.file);
  return {
    blobs,
    draft: createStudioChangeSet({
      draftId: DRAFT_ID,
      primaryResource: { kind: "workflow", id: "sample" },
      resources: [{ kind: "workflow", id: "sample" }],
      resourceRevisions: { "workflow:sample": digest("revision") },
      baseBundleHash: digest("base-bundle"),
      technicalCatalogFingerprint: digest("technical-catalog"),
      presentationCatalogFingerprint: digest("presentation-catalog"),
      baseFiles: input.baseFiles,
      dependencies: input.dependencies ?? [],
      allowedFiles,
      changes: input.changes,
      now: "2026-07-10T20:00:00.000Z"
    })
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("filesystem Studio validation snapshot", () => {
  it("materializes a private source-plus-overlay snapshot across logical roots", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const workflowPath = "workflows/sample/workflow.yaml";
    const removedPath = "workflows/sample/removed.json";
    const agentPath = "agents/helper/agent.yaml";
    const configPath = "workflow-config/sample.yaml";
    const originalWorkflow = "id: sample\nvalue: old\n";
    const updatedWorkflow = "id: sample\nvalue: updated\n";
    const removedContent = "{\"remove\":true}\n";
    const agentContent = "id: helper\n";
    const configContent = "enabled: true\n";
    await writeSource(projectRoot, workflowPath, originalWorkflow);
    await writeSource(projectRoot, removedPath, removedContent);
    await writeSource(projectRoot, agentPath, agentContent);
    await writeSource(projectRoot, "unrelated/private.txt", "not copied\n");

    const fixture = draftFixture({
      baseFiles: [
        {
          file: { root: "project", path: workflowPath },
          sha256: digest(originalWorkflow),
          content_ref: digest(originalWorkflow)
        },
        {
          file: { root: "project", path: removedPath },
          sha256: digest(removedContent),
          content_ref: digest(removedContent)
        },
        {
          file: { root: "config", path: configPath },
          sha256: null,
          content_ref: null
        }
      ],
      dependencies: [
        {
          file: { root: "project", path: agentPath },
          sha256: digest(agentContent)
        }
      ],
      changes: [
        {
          action: "write",
          file: { root: "project", path: workflowPath },
          base_sha256: digest(originalWorkflow),
          content_sha256: digest(updatedWorkflow),
          content_ref: digest(updatedWorkflow)
        },
        {
          action: "delete",
          file: { root: "project", path: removedPath },
          base_sha256: digest(removedContent)
        },
        {
          action: "write",
          file: { root: "config", path: configPath },
          base_sha256: null,
          content_sha256: digest(configContent),
          content_ref: digest(configContent)
        }
      ],
      blobContents: [
        originalWorkflow,
        removedContent,
        updatedWorkflow,
        configContent
      ]
    });
    const snapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs: new MemoryBlobStore(fixture.blobs)
    });

    const snapshot = await snapshots.create(fixture.draft);

    await expect(
      readFile(path.join(snapshot.projectRoot, workflowPath), "utf8")
    ).resolves.toBe(updatedWorkflow);
    await expect(
      readFile(path.join(snapshot.projectRoot, agentPath), "utf8")
    ).resolves.toBe(agentContent);
    await expect(
      readFile(path.join(snapshot.configRoot, configPath), "utf8")
    ).resolves.toBe(configContent);
    await expect(
      access(path.join(snapshot.projectRoot, removedPath))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(snapshot.projectRoot, "unrelated/private.txt"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.dirname(snapshot.projectRoot))).mode & 0o777).toBe(
      0o700
    );
    expect((await stat(path.join(snapshot.projectRoot, workflowPath))).mode & 0o777)
      .toBe(0o600);
    expect(snapshot.verifiedFiles).toHaveLength(4);
    expect(await readFile(path.join(projectRoot, workflowPath), "utf8")).toBe(
      originalWorkflow
    );

    const snapshotDirectory = path.dirname(snapshot.projectRoot);
    await snapshot.dispose();
    await snapshot.dispose();
    await expect(access(snapshotDirectory)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects changed, missing, and unexpectedly created base files", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const file = { root: "project", path: "workflows/sample/workflow.yaml" } as const;
    const original = "id: sample\n";
    await writeSource(projectRoot, file.path, "externally changed\n");
    const existingFixture = draftFixture({
      baseFiles: [
        { file, sha256: digest(original), content_ref: digest(original) }
      ],
      blobContents: [original]
    });
    const existingSnapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs: new MemoryBlobStore(existingFixture.blobs)
    });
    await expect(existingSnapshots.create(existingFixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_source_conflict",
      details: { file, expectedSha256: digest(original) }
    });

    await rm(path.join(projectRoot, file.path));
    await expect(existingSnapshots.create(existingFixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_source_conflict",
      details: { file, expectedSha256: digest(original), actualSha256: null }
    });

    await writeSource(projectRoot, file.path, original);
    const newFixture = draftFixture({
      baseFiles: [{ file, sha256: null, content_ref: null }],
      blobContents: []
    });
    const newSnapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs: new MemoryBlobStore(newFixture.blobs)
    });
    await expect(newSnapshots.create(newFixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_source_conflict",
      details: { file, expectedSha256: null }
    });
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("pins dependency hashes and rejects a dependency changed on disk", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const dependencyPath = "agents/helper/agent.yaml";
    await writeSource(projectRoot, dependencyPath, "changed\n");
    const expected = "id: helper\n";
    const fixture = draftFixture({
      baseFiles: [],
      dependencies: [
        {
          file: { root: "project", path: dependencyPath },
          sha256: digest(expected)
        }
      ],
      blobContents: []
    });
    const snapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs: new MemoryBlobStore(fixture.blobs)
    });

    await expect(snapshots.create(fixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_source_conflict",
      details: {
        file: { root: "project", path: dependencyPath },
        expectedSha256: digest(expected)
      }
    });
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("rejects a source path whose symlink escapes its logical root", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const outsideRoot = await temporaryDirectory("luna-studio-outside-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    await writeSource(outsideRoot, "workflow.yaml", "id: sample\n");
    await mkdir(path.join(projectRoot, "workflows"));
    await symlink(outsideRoot, path.join(projectRoot, "workflows", "sample"), "dir");
    const content = "id: sample\n";
    const fixture = draftFixture({
      baseFiles: [
        {
          file: {
            root: "project",
            path: "workflows/sample/workflow.yaml"
          },
          sha256: digest(content),
          content_ref: digest(content)
        }
      ],
      blobContents: [content]
    });
    const snapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs: new MemoryBlobStore(fixture.blobs)
    });

    await expect(snapshots.create(fixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_path_invalid"
    });
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("verifies blob content even when the blob-store port misbehaves", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const content = "id: sample\n";
    const file = {
      root: "project",
      path: "workflows/sample/workflow.yaml"
    } as const;
    await writeSource(projectRoot, file.path, content);
    const fixture = draftFixture({
      baseFiles: [
        { file, sha256: digest(content), content_ref: digest(content) }
      ],
      blobContents: ["wrong content\n"]
    });
    const dishonestStore: StudioDraftBlobReaderPort = {
      async getBlob(): Promise<string> {
        return "wrong content\n";
      }
    };
    const snapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs: dishonestStore
    });

    await expect(snapshots.create(fixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_blob_invalid",
      details: { file }
    });
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("bounds individual source files and aggregate snapshot bytes", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const first = "12345";
    const second = "67890";
    await writeSource(projectRoot, "agents/first/agent.yaml", first);
    await writeSource(projectRoot, "agents/second/agent.yaml", second);
    const fixture = draftFixture({
      baseFiles: [],
      dependencies: [
        {
          file: { root: "project", path: "agents/first/agent.yaml" },
          sha256: digest(first)
        },
        {
          file: { root: "project", path: "agents/second/agent.yaml" },
          sha256: digest(second)
        }
      ],
      blobContents: []
    });
    const sourceLimited = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      maxSourceFileBytes: 4,
      blobs: new MemoryBlobStore(fixture.blobs)
    });
    await expect(sourceLimited.create(fixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_source_too_large",
      details: { actualBytes: 5, maxBytes: 4 }
    });

    const workflowFile = {
      root: "project",
      path: "workflows/sample/workflow.yaml"
    } as const;
    const workflowBase = "old";
    const workflowDraft = "12345";
    await writeSource(projectRoot, workflowFile.path, workflowBase);
    const overlayFixture = draftFixture({
      baseFiles: [
        {
          file: workflowFile,
          sha256: digest(workflowBase),
          content_ref: digest(workflowBase)
        }
      ],
      changes: [
        {
          action: "write",
          file: workflowFile,
          base_sha256: digest(workflowBase),
          content_sha256: digest(workflowDraft),
          content_ref: digest(workflowDraft)
        }
      ],
      blobContents: [workflowBase, workflowDraft]
    });
    const overlayLimited = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      maxSourceFileBytes: 4,
      blobs: new MemoryBlobStore(overlayFixture.blobs)
    });
    await expect(overlayLimited.create(overlayFixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_source_too_large",
      details: { file: workflowFile, actualBytes: 5, maxBytes: 4 }
    });

    const aggregateLimited = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      maxSnapshotBytes: 9,
      blobs: new MemoryBlobStore(fixture.blobs)
    });
    await expect(aggregateLimited.create(fixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_total_too_large",
      details: { actualBytes: 10, maxBytes: 9 }
    });
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("charges deleted bases and every overlay phase to the aggregate budget", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const file = {
      root: "project",
      path: "workflows/sample/workflow.yaml"
    } as const;
    const base = "12345";
    await writeSource(projectRoot, file.path, base);

    const deleted = draftFixture({
      baseFiles: [
        { file, sha256: digest(base), content_ref: digest(base) }
      ],
      changes: [
        { action: "delete", file, base_sha256: digest(base) }
      ],
      blobContents: [base]
    });
    const deleteLimited = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      maxSnapshotBytes: 4,
      blobs: new MemoryBlobStore(deleted.blobs)
    });
    await expect(deleteLimited.create(deleted.draft)).rejects.toMatchObject({
      code: "studio_snapshot_total_too_large",
      details: {
        file,
        actualBytes: 5,
        maxBytes: 4,
        work: "source_read"
      }
    });

    const overlay = "x";
    const overlaid = draftFixture({
      baseFiles: [
        { file, sha256: digest(base), content_ref: digest(base) }
      ],
      changes: [
        {
          action: "write",
          file,
          base_sha256: digest(base),
          content_sha256: digest(overlay),
          content_ref: digest(overlay)
        }
      ],
      blobContents: [base, overlay]
    });
    const overlayLimited = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      maxSnapshotBytes: 6,
      blobs: new MemoryBlobStore(overlaid.blobs)
    });
    await expect(overlayLimited.create(overlaid.draft)).rejects.toMatchObject({
      code: "studio_snapshot_total_too_large",
      details: {
        file,
        actualBytes: 7,
        maxBytes: 6,
        work: "materialize"
      }
    });
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("enforces the requested bound when a blob store returns oversized content", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const file = {
      root: "project",
      path: "workflows/sample/workflow.yaml"
    } as const;
    const content = "12345";
    const fixture = draftFixture({
      baseFiles: [{ file, sha256: null, content_ref: null }],
      changes: [
        {
          action: "write",
          file,
          base_sha256: null,
          content_sha256: digest(content),
          content_ref: digest(content)
        }
      ],
      blobContents: [content]
    });
    let requestedMaxBytes: number | undefined;
    const dishonestStore: StudioDraftBlobReaderPort = {
      async getBlob(_draftId, _digest, options): Promise<string> {
        requestedMaxBytes = options.maxBytes;
        return content;
      }
    };
    const snapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      maxSnapshotBytes: 4,
      blobs: dishonestStore
    });

    await expect(snapshots.create(fixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_total_too_large",
      details: { actualBytes: 5, maxBytes: 4, work: "blob_read" }
    });
    expect(requestedMaxBytes).toBe(4);
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("rejects excessive file counts before creating private snapshot data", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const first = "first";
    const second = "second";
    await writeSource(projectRoot, "agents/first/agent.yaml", first);
    await writeSource(projectRoot, "agents/second/agent.yaml", second);
    const fixture = draftFixture({
      baseFiles: [],
      dependencies: [
        {
          file: { root: "project", path: "agents/first/agent.yaml" },
          sha256: digest(first)
        },
        {
          file: { root: "project", path: "agents/second/agent.yaml" },
          sha256: digest(second)
        }
      ],
      blobContents: []
    });
    const snapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      maxSnapshotFiles: 1,
      blobs: new MemoryBlobStore(fixture.blobs)
    });

    await expect(snapshots.create(fixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_too_many_files",
      details: { actualFiles: 2, maxFiles: 1 }
    });
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("fails closed when a parent directory is swapped after resolution", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const outsideRoot = await temporaryDirectory("luna-studio-outside-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const file = {
      root: "project",
      path: "workflows/sample/workflow.yaml"
    } as const;
    const content = "id: sample\n";
    await writeSource(projectRoot, file.path, content);
    await writeSource(outsideRoot, "workflow.yaml", content);
    const fixture = draftFixture({
      baseFiles: [
        { file, sha256: digest(content), content_ref: digest(content) }
      ],
      blobContents: [content]
    });
    const sourceParent = path.join(projectRoot, "workflows", "sample");
    let swapped = false;
    const snapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs: new MemoryBlobStore(fixture.blobs),
      faultInjector: async (stage) => {
        if (stage !== "after_source_resolved" || swapped) {
          return;
        }
        swapped = true;
        await rename(sourceParent, `${sourceParent}-original`);
        await symlink(outsideRoot, sourceParent, "dir");
      }
    });

    await expect(snapshots.create(fixture.draft)).rejects.toMatchObject({
      code: "studio_snapshot_path_invalid",
      details: { file }
    });
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it("preserves operation and cleanup failures as a structured aggregate", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-");
    const temporaryRoot = await temporaryDirectory("luna-studio-snapshots-");
    const file = {
      root: "project",
      path: "workflows/sample/workflow.yaml"
    } as const;
    const expected = "id: sample\n";
    await writeSource(projectRoot, file.path, "changed\n");
    const fixture = draftFixture({
      baseFiles: [
        { file, sha256: digest(expected), content_ref: digest(expected) }
      ],
      blobContents: [expected]
    });
    const snapshots = new FileSystemStudioValidationSnapshot({
      projectRoot,
      configRoot,
      temporaryRoot,
      blobs: new MemoryBlobStore(fixture.blobs),
      faultInjector(stage) {
        if (stage === "before_snapshot_cleanup") {
          throw new Error("injected cleanup failure");
        }
      }
    });

    let caught: unknown;
    try {
      await snapshots.create(fixture.draft);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(StudioSnapshotCleanupAggregateError);
    expect(caught).toMatchObject({
      code: "studio_snapshot_cleanup_failed",
      operationCause: { code: "studio_snapshot_source_conflict" },
      cleanupCause: { code: "studio_snapshot_cleanup_failed" }
    });
    expect((caught as AggregateError).errors).toHaveLength(2);
  });
});
