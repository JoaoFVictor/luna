import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { RunLockManager } from "../../../src/core/workflow/lock-manager.js";
import { createStudioChangeSet } from "../../../src/studio/application/drafts/change-set.js";
import type {
  StudioDraftBlob,
  StudioDraftLockPort
} from "../../../src/studio/application/drafts/persistence.js";
import {
  FileSystemStudioDraftRepository,
  type FileSystemStudioDraftRepositoryOptions,
  type StudioDraftStorageLimits
} from "../../../src/studio/adapters/filesystem/draft-repository.js";
import type { StudioChangeSet } from "../../../src/studio/contracts/drafts.js";
import { studioResourceKey, type StudioResourceRef } from "../../../src/studio/contracts/paths.js";

export const DRAFT_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003"
] as const;
export const DRAFT_ID = DRAFT_IDS[0];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

export function rawDigest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export function blob(content: string): StudioDraftBlob {
  return { digest: rawDigest(content), content };
}

export function draftRoot(root: string, draftId: string = DRAFT_ID): string {
  return path.join(root, ".luna", "studio", "drafts", draftId);
}

export function digestPath(root: string, draftId: string, digest: string): string {
  return path.join(
    draftRoot(root, draftId),
    "files",
    digest.slice("sha256:".length)
  );
}

export async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-drafts-"));
  roots.push(root);
  return root;
}

export function createRepository(
  root: string,
  runId: string,
  options: {
    readonly limits?: Partial<StudioDraftStorageLimits>;
    readonly now?: () => number;
    readonly lockManager?: StudioDraftLockPort;
    readonly deleteFaultInjector?: FileSystemStudioDraftRepositoryOptions["deleteFaultInjector"];
    readonly createFaultInjector?: FileSystemStudioDraftRepositoryOptions["createFaultInjector"];
    readonly rootMaintenanceFaultInjector?: FileSystemStudioDraftRepositoryOptions["rootMaintenanceFaultInjector"];
    readonly onLockReleaseError?: FileSystemStudioDraftRepositoryOptions["onLockReleaseError"];
  } = {}
): FileSystemStudioDraftRepository {
  const lockManager = options.lockManager ?? new RunLockManager({
    root: path.join(root, ".luna", "studio", "locks"),
    runId,
    timeoutMs: 2_000,
    staleAfterMs: 3_000
  });
  return new FileSystemStudioDraftRepository({
    projectRoot: root,
    ...options,
    lockManager
  });
}

export function draftWithBlobs(input: {
  readonly baseDigest: string;
  readonly changeDigest: string;
  readonly draftId?: string;
  readonly resource?: StudioResourceRef;
}): StudioChangeSet {
  const draftId = input.draftId ?? DRAFT_ID;
  const resource = input.resource ?? {
    kind: "workflow" as const,
    id: `sample-${draftId.at(-1)}`
  };
  return createStudioChangeSet({
    draftId,
    primaryResource: resource,
    resources: [resource],
    resourceRevisions: {
      [studioResourceKey(resource)]: rawDigest("workflow-revision")
    },
    baseBundleHash: rawDigest("base-bundle"),
    technicalCatalogFingerprint: rawDigest("technical-catalog"),
    presentationCatalogFingerprint: rawDigest("presentation-catalog"),
    baseFiles: [
      {
        file: {
          root: "project",
          path: `workflows/sample-${draftId.at(-1)}/workflow.yaml`
        },
        sha256: input.baseDigest,
        content_ref: input.baseDigest,
        mode: 0o644
      }
    ],
    dependencies: [],
    allowedFiles: [
      {
        root: "project",
        path: `workflows/sample-${draftId.at(-1)}/workflow.yaml`
      }
    ],
    changes: [
      {
        action: "write",
        file: {
          root: "project",
          path: `workflows/sample-${draftId.at(-1)}/workflow.yaml`
        },
        base_sha256: input.baseDigest,
        content_sha256: input.changeDigest,
        content_ref: input.changeDigest,
        eol: "lf",
        mode: 0o600
      }
    ],
    now: "2026-07-10T12:00:00.000Z"
  });
}

export async function seedDraft(
  repository: FileSystemStudioDraftRepository,
  draftId: string = DRAFT_ID
): Promise<{
  readonly draft: StudioChangeSet;
  readonly baseBlob: StudioDraftBlob;
  readonly changeBlob: StudioDraftBlob;
}> {
  const baseBlob = blob("name: sample\n");
  const changeBlob = blob(`name: updated-${draftId.at(-1)}\n`);
  const draft = draftWithBlobs({
    baseDigest: baseBlob.digest,
    changeDigest: changeBlob.digest,
    draftId
  });
  await repository.create({
    changeSet: draft,
    blobs: [baseBlob, changeBlob]
  });
  return { draft, baseBlob, changeBlob };
}

export function versionOf(draft: StudioChangeSet) {
  return {
    recordRevision: draft.record_revision,
    contentRevision: draft.content_revision,
    layoutRevision: draft.layout_revision
  };
}

export function modeBits(mode: number): number {
  return mode & 0o777;
}
