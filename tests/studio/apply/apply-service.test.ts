import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemStudioApplyJournal } from "../../../src/studio/adapters/filesystem/apply-journal.js";
import {
  FileSystemStudioApplyTransaction,
  createStudioApplyWorkspaceFaultAdapter,
  type StudioApplyFaultStage
} from "../../../src/studio/adapters/filesystem/apply-transaction.js";
import {
  FileSystemStudioApplySource,
  StudioApplyPathResolver
} from "../../../src/studio/adapters/filesystem/apply-paths.js";
import { StudioApplyWorkspace } from "../../../src/studio/adapters/filesystem/apply-workspace.js";
import { FileSystemStudioLockManager } from "../../../src/studio/adapters/filesystem/studio-lock-manager.js";
import { MemoryStudioApplyPlanTokens } from "../../../src/studio/adapters/memory/apply-plan-tokens.js";
import {
  createStudioChangeSet,
  replaceStudioDraftLayout
} from "../../../src/studio/application/drafts/change-set.js";
import type {
  StudioDraftCreate,
  StudioDraftDelete,
  StudioDraftListInput,
  StudioDraftPersistencePort,
  StudioDraftUpdate
} from "../../../src/studio/application/drafts/persistence.js";
import {
  studioApplyBytesDigest,
  studioApplyValueDigest
} from "../../../src/studio/application/apply/digests.js";
import { StudioApplySimulatedCrash } from "../../../src/studio/application/apply/errors.js";
import {
  StudioApplyService
} from "../../../src/studio/application/apply/service.js";
import {
  STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE,
  studioConfigurationApplyScope
} from "../../../src/studio/application/apply/scope.js";
import { studioDraftEtag } from "../../../src/studio/application/drafts/versioning.js";
import type { StudioInstalledApplyVerificationPort } from "../../../src/studio/application/apply/ports.js";
import type { StudioDraftValidationService } from "../../../src/studio/application/validation/draft-validation.js";
import type {
  StudioChangeSet,
  StudioDraftListPage
} from "../../../src/studio/contracts/drafts.js";
import type { StudioDraftValidationResult } from "../../../src/studio/contracts/validation.js";

const temporaryRoots: string[] = [];
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_REVISION = studioApplyValueDigest({ workflow: "demo-v2" });

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) =>
      await rm(root, { recursive: true, force: true })
    )
  );
});

class MemoryDraftPersistence implements StudioDraftPersistencePort {
  draft: StudioChangeSet;
  available = true;
  readonly blobs: Map<string, string>;

  constructor(draft: StudioChangeSet, blobs: ReadonlyMap<string, string>) {
    this.draft = draft;
    this.blobs = new Map(blobs);
  }

  async getBlob(
    draftId: string,
    digest: string,
    options: { readonly maxBytes: number }
  ): Promise<string> {
    if (draftId !== this.draft.draft_id) {
      throw new Error("missing draft");
    }
    const value = this.blobs.get(digest);
    if (value === undefined) {
      throw new Error("missing blob");
    }
    if (Buffer.byteLength(value, "utf8") > options.maxBytes) {
      throw new Error("blob too large");
    }
    return value;
  }

  async create(input: StudioDraftCreate): Promise<StudioChangeSet> {
    this.draft = input.changeSet;
    return this.draft;
  }

  async get(draftId: string): Promise<StudioChangeSet | undefined> {
    return this.available && draftId === this.draft.draft_id
      ? this.draft
      : undefined;
  }

  async list(_input?: StudioDraftListInput): Promise<StudioDraftListPage> {
    return { items: [], diagnostics: [], next_cursor: null };
  }

  async update(input: StudioDraftUpdate): Promise<StudioChangeSet> {
    this.draft = input.changeSet;
    return this.draft;
  }

  async delete(_input: StudioDraftDelete): Promise<void> {
    throw new Error("not used");
  }
}

type ApplyFixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(options: {
  readonly baseExists?: boolean;
  readonly dependency?: boolean;
  readonly after?: string;
  readonly diffLimit?: number;
  readonly crashAt?: StudioApplyFaultStage;
  readonly baseMode?: number;
  readonly afterMode?: number;
} = {}) {
  const projectRoot = await temporaryRoot("luna-studio-service-project-");
  const configRoot = await temporaryRoot("luna-studio-service-config-");
  await mkdir(path.join(projectRoot, "workflows", "demo"), {
    recursive: true
  });
  const baseExists = options.baseExists ?? true;
  const baseMode = options.baseMode ?? 0o644;
  const afterMode = options.afterMode ?? (baseExists ? baseMode : 0o644);
  const before = baseExists ? "name: old\napi_token: old-secret\n" : undefined;
  const after = options.after ?? "name: new\napi_token: new-super-secret\n";
  const file = { root: "project" as const, path: "workflows/demo/workflow.yaml" };
  const target = path.join(projectRoot, ...file.path.split("/"));
  if (before !== undefined) {
    await writeFile(target, before, { mode: baseMode });
  }
  const beforeDigest =
    before === undefined
      ? null
      : studioApplyBytesDigest(Buffer.from(before, "utf8"));
  const afterDigest = studioApplyBytesDigest(Buffer.from(after, "utf8"));
  const catalogFingerprint = studioApplyValueDigest({ catalog: "current" });
  const dependencies: StudioChangeSet["dependencies"] = [];
  if (options.dependency) {
    await mkdir(path.join(projectRoot, "agents", "helper"), { recursive: true });
    const dependencyContent = "Help safely.\n";
    await writeFile(
      path.join(projectRoot, "agents", "helper", "instructions.md"),
      dependencyContent
    );
    dependencies.push({
      file: {
        root: "project",
        path: "agents/helper/instructions.md"
      },
      sha256: studioApplyBytesDigest(Buffer.from(dependencyContent, "utf8"))
    });
  }
  const draft = createStudioChangeSet({
    draftId: DRAFT_ID,
    primaryResource: { kind: "workflow", id: "demo" },
    resources: [{ kind: "workflow", id: "demo" }],
    resourceRevisions: {
      "workflow:demo": beforeDigest
    },
    baseBundleHash: beforeDigest,
    technicalCatalogFingerprint: catalogFingerprint,
    presentationCatalogFingerprint: studioApplyValueDigest({ labels: "test" }),
    baseFiles: [
      {
        file,
        sha256: beforeDigest,
        content_ref: beforeDigest,
        mode: beforeDigest === null ? null : baseMode
      }
    ],
    dependencies,
    allowedFiles: [file],
    changes: [
      {
        action: "write",
        file,
        base_sha256: beforeDigest,
        content_sha256: afterDigest,
        content_ref: afterDigest,
        mode: afterMode
      }
    ],
    now: "2026-07-10T12:00:00.000Z"
  });
  const blobs = new Map<string, string>([[afterDigest, after]]);
  if (beforeDigest !== null && before !== undefined) {
    blobs.set(beforeDigest, before);
  }
  const persistence = new MemoryDraftPersistence(draft, blobs);
  const validationResult = (changeSet: StudioChangeSet): StudioDraftValidationResult => ({
    draft_id: changeSet.draft_id,
    record_revision: changeSet.record_revision,
    content_revision: changeSet.content_revision,
    layout_revision: changeSet.layout_revision,
    draft_hash: changeSet.draft_hash,
    status: "valid",
    compiled: true,
    resources: [
      {
        resource: { kind: "workflow", id: "demo" },
        status: "valid",
        revision: WORKFLOW_REVISION,
        diagnostics: [],
        compiled_workflow: {
          workflow_id: "demo",
          workflow_revision: WORKFLOW_REVISION,
          state_schema_version: "test-state-v1",
          nodes: [],
          edges: []
        }
      }
    ],
    diagnostics: [],
    validated_at: "2026-07-10T12:00:00.000Z"
  });
  const validation: Pick<StudioDraftValidationService, "validate"> = {
    validate: async (changeSet) => validationResult(changeSet)
  };
  let now = Date.parse("2026-07-10T12:00:00.000Z");
  let currentCatalog = catalogFingerprint;
  const resolver = new StudioApplyPathResolver({
    project: projectRoot,
    config: configRoot
  });
  const source = new FileSystemStudioApplySource(resolver);
  const journal = new FileSystemStudioApplyJournal({ projectRoot });
  let crashed = false;
  const faultInjector = (stage: StudioApplyFaultStage) => {
    if (!crashed && stage === options.crashAt) {
      crashed = true;
      throw new StudioApplySimulatedCrash();
    }
  };
  const workspace = new StudioApplyWorkspace({
    resolver,
    source,
    maxFileBytes: 1024 * 1024,
    faultInjector: createStudioApplyWorkspaceFaultAdapter(faultInjector)
  });
  const transactions = new FileSystemStudioApplyTransaction({
    journal,
    workspace,
    faultInjector
  });
  const installedVerifier: StudioInstalledApplyVerificationPort = {
    verify: async () => ({ "workflow:demo": WORKFLOW_REVISION })
  };
  const planTokens = new MemoryStudioApplyPlanTokens({ now: () => now });
  const service = new StudioApplyService({
    drafts: persistence,
    source,
    validation,
    planTokens,
    transactions,
    lockManager: new FileSystemStudioLockManager({
      projectRoot,
      startupOwnerId: "apply-service-owner-001",
      timeoutMs: 2_000,
      staleAfterMs: 3_000
    }),
    installedVerifier,
    technicalCatalogFingerprint: () => currentCatalog,
    compilerContractVersion: "test-compiler-v1",
    now: () => now,
    limits: {
      planTtlMs: 1_000,
      maxDiffFileBytes: options.diffLimit ?? 64 * 1024,
      maxDiffTotalBytes: options.diffLimit ?? 64 * 1024
    }
  });
  return {
    projectRoot,
    configRoot,
    file,
    target,
    before,
    after,
    beforeDigest,
    afterDigest,
    dependency: dependencies[0],
    persistence,
    service,
    journal,
    planTokens,
    advance(ms: number) {
      now += ms;
    },
    changeCatalog() {
      currentCatalog = studioApplyValueDigest({ catalog: "changed" });
    }
  };
}

async function readyPlan(fixture: ApplyFixture) {
  const plan = await fixture.service.plan(
    DRAFT_ID,
    STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
  );
  expect(plan.status).toBe("ready");
  if (plan.status !== "ready") {
    throw new Error("expected ready plan");
  }
  return plan;
}

describe("StudioApplyService", () => {
  it("redacts and bounds textual diff, then commits and replays idempotently", async () => {
    const fixture = await createFixture({ diffLimit: 96 });
    const plan = await readyPlan(fixture);
    expect(plan.diff).toHaveLength(1);
    expect(plan.diff[0]?.textual_diff).not.toContain("new-super-secret");
    expect(plan.diff[0]?.textual_diff).not.toContain("old-secret");
    expect(plan.diff[0]?.textual_diff_truncated).toBe(true);
    expect(Buffer.byteLength(plan.diff[0]!.textual_diff, "utf8")).toBeLessThanOrEqual(96);
    const tokenRecord = await fixture.planTokens.get(plan.plan_token);
    expect(tokenRecord?.plan.binding.diffDigest).toBe(
      studioApplyValueDigest(plan.diff)
    );

    const ifMatch = studioDraftEtag(fixture.persistence.draft);
    const result = await fixture.service.apply(DRAFT_ID, {
      planToken: plan.plan_token,
      idempotencyKey: "apply-demo-0001",
      ifMatch
    }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE);
    expect(result.status).toBe("committed");
    expect(result.idempotent_replay).toBe(false);
    expect(result.diff).toEqual(plan.diff);
    expect(await readFile(fixture.target, "utf8")).toBe(fixture.after);

    fixture.persistence.draft = replaceStudioDraftLayout(
      fixture.persistence.draft,
      { moved_after_commit: true },
      "2026-07-10T12:00:01.000Z"
    );
    fixture.advance(5_000);
    const replay = await fixture.service.apply(DRAFT_ID, {
      planToken: plan.plan_token,
      idempotencyKey: "apply-demo-0001",
      ifMatch
    }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE);
    expect(replay.operation_id).toBe(result.operation_id);
    expect(replay.idempotent_replay).toBe(true);

    fixture.persistence.available = false;
    await expect(fixture.service.apply(DRAFT_ID, {
      planToken: plan.plan_token,
      idempotencyKey: "apply-demo-0001",
      ifMatch
    }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE)).resolves.toMatchObject({
      operation_id: result.operation_id,
      idempotent_replay: true
    });

    await expect(
      fixture.service.apply(DRAFT_ID, {
        planToken: plan.plan_token,
        idempotencyKey: "apply-demo-0001",
        ifMatch: `${ifMatch}changed`
      }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE)
    ).rejects.toMatchObject({ code: "studio_apply_idempotency_conflict" });
  });

  it("binds apply idempotency to its Studio surface before any transaction", async () => {
    const fixture = await createFixture();
    const plan = await readyPlan(fixture);
    const ifMatch = studioDraftEtag(fixture.persistence.draft);
    const configurationScope = studioConfigurationApplyScope("demo");

    await expect(fixture.service.plan(
      DRAFT_ID,
      configurationScope
    )).rejects.toMatchObject({ code: "studio_apply_draft_not_found" });
    await expect(fixture.service.apply(DRAFT_ID, {
      planToken: plan.plan_token,
      idempotencyKey: "wrong-surface-apply-01",
      ifMatch
    }, configurationScope)).rejects.toMatchObject({
      code: "studio_apply_draft_not_found"
    });
    expect(await readFile(fixture.target, "utf8")).toBe(fixture.before);

    const committed = await fixture.service.apply(DRAFT_ID, {
      planToken: plan.plan_token,
      idempotencyKey: "surface-bound-replay-01",
      ifMatch
    }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE);
    await expect(fixture.service.apply(DRAFT_ID, {
      planToken: plan.plan_token,
      idempotencyKey: "surface-bound-replay-01",
      ifMatch
    }, configurationScope)).rejects.toMatchObject({
      code: "studio_apply_idempotency_conflict",
      details: { operationId: committed.operation_id }
    });
  });

  it("returns created, modified, and deleted source conflicts without a token", async () => {
    const modified = await createFixture();
    await writeFile(modified.target, "name: external\n");
    await expect(modified.service.plan(
      DRAFT_ID,
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    )).resolves.toMatchObject({
      status: "conflicted",
      conflicts: [{ kind: "modified" }]
    });

    const created = await createFixture({ baseExists: false });
    await writeFile(created.target, "name: external\n");
    await expect(created.service.plan(
      DRAFT_ID,
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    )).resolves.toMatchObject({
      status: "conflicted",
      conflicts: [{ kind: "created" }]
    });

    const deleted = await createFixture();
    await unlink(deleted.target);
    await expect(deleted.service.plan(
      DRAFT_ID,
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    )).resolves.toMatchObject({
      status: "conflicted",
      conflicts: [{ kind: "deleted" }]
    });
  });

  it("rechecks base and dependency hashes under the apply lock", async () => {
    const fixture = await createFixture({ dependency: true });
    const plan = await readyPlan(fixture);
    const dependencyPath = path.join(
      fixture.projectRoot,
      ...fixture.dependency!.file.path.split("/")
    );
    await writeFile(dependencyPath, "Externally changed.\n");
    await expect(
      fixture.service.apply(DRAFT_ID, {
        planToken: plan.plan_token,
        idempotencyKey: "dependency-change-1",
        ifMatch: studioDraftEtag(fixture.persistence.draft)
      }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE)
    ).rejects.toMatchObject({
      code: "studio_apply_source_conflict",
      details: { conflicts: [{ kind: "modified" }] }
    });
    expect(await readFile(fixture.target, "utf8")).toBe(fixture.before);
  });

  it("serializes concurrent confirmations so only one can commit", async () => {
    const fixture = await createFixture();
    const plan = await readyPlan(fixture);
    const ifMatch = studioDraftEtag(fixture.persistence.draft);
    const outcomes = await Promise.allSettled([
      fixture.service.apply(DRAFT_ID, {
        planToken: plan.plan_token,
        idempotencyKey: "concurrent-apply-01",
        ifMatch
      }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE),
      fixture.service.apply(DRAFT_ID, {
        planToken: plan.plan_token,
        idempotencyKey: "concurrent-apply-02",
        ifMatch
      }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "studio_apply_source_conflict" }
    });
    expect(await readFile(fixture.target, "utf8")).toBe(fixture.after);
  });

  it("binds the confirmed diff to the source file mode", async () => {
    const fixture = await createFixture();
    const plan = await readyPlan(fixture);
    await chmod(fixture.target, 0o600);
    await expect(
      fixture.service.apply(DRAFT_ID, {
        planToken: plan.plan_token,
        idempotencyKey: "mode-change-0001",
        ifMatch: studioDraftEtag(fixture.persistence.draft)
      }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE)
    ).rejects.toMatchObject({
      code: "studio_apply_source_conflict",
      details: {
        conflicts: [
          {
            kind: "modified",
            expected_mode: 0o644,
            actual_mode: 0o600
          }
        ]
      }
    });
    expect(await readFile(fixture.target, "utf8")).toBe(fixture.before);
  });

  it("detects chmod before planning and applies an explicit mode-only change", async () => {
    const conflicted = await createFixture({
      after: "name: old\napi_token: old-secret\n",
      afterMode: 0o600
    });
    await chmod(conflicted.target, 0o600);
    await expect(conflicted.service.plan(
      DRAFT_ID,
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    )).resolves.toMatchObject({
      status: "conflicted",
      conflicts: [
        {
          kind: "modified",
          expected_mode: 0o644,
          actual_mode: 0o600
        }
      ]
    });

    const modeOnly = await createFixture({
      after: "name: old\napi_token: old-secret\n",
      afterMode: 0o755
    });
    const plan = await readyPlan(modeOnly);
    expect(plan.diff[0]).toMatchObject({
      before_sha256: modeOnly.beforeDigest,
      after_sha256: modeOnly.beforeDigest,
      before_mode: 0o644,
      after_mode: 0o755
    });
    await modeOnly.service.apply(DRAFT_ID, {
      planToken: plan.plan_token,
      idempotencyKey: "mode-only-change-01",
      ifMatch: studioDraftEtag(modeOnly.persistence.draft)
    }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE);
    expect(await readFile(modeOnly.target, "utf8")).toBe(modeOnly.before);
    expect((await stat(modeOnly.target)).mode & 0o777).toBe(0o755);
  });

  it("rejects expired tokens, changed compiler authority, and changed draft records", async () => {
    const expired = await createFixture();
    const expiredPlan = await readyPlan(expired);
    expired.advance(1_001);
    await expect(
      expired.service.apply(DRAFT_ID, {
        planToken: expiredPlan.plan_token,
        idempotencyKey: "expired-plan-001",
        ifMatch: studioDraftEtag(expired.persistence.draft)
      }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE)
    ).rejects.toMatchObject({ code: "studio_apply_plan_expired" });

    const catalog = await createFixture();
    const catalogPlan = await readyPlan(catalog);
    catalog.changeCatalog();
    await expect(
      catalog.service.apply(DRAFT_ID, {
        planToken: catalogPlan.plan_token,
        idempotencyKey: "catalog-change-1",
        ifMatch: studioDraftEtag(catalog.persistence.draft)
      }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE)
    ).rejects.toMatchObject({ code: "studio_apply_plan_stale" });

    const revised = await createFixture();
    const revisedPlan = await readyPlan(revised);
    revised.persistence.draft = replaceStudioDraftLayout(
      revised.persistence.draft,
      { x: 1 },
      "2026-07-10T12:00:01.000Z"
    );
    await expect(
      revised.service.apply(DRAFT_ID, {
        planToken: revisedPlan.plan_token,
        idempotencyKey: "revised-draft-01",
        ifMatch: studioDraftEtag(revised.persistence.draft)
      }, STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE)
    ).rejects.toMatchObject({ code: "studio_apply_plan_stale" });
  });

  it("rejects a configured per-file diff limit larger than the public contract", async () => {
    await expect(
      createFixture({ diffLimit: 256 * 1024 + 1 })
    ).rejects.toMatchObject({ code: "studio_apply_config_invalid" });
  });

  it("reports a non-terminal idempotent attempt as recovery_required", async () => {
    const fixture = await createFixture({ crashAt: "after_installing" });
    const plan = await readyPlan(fixture);
    const request = {
      planToken: plan.plan_token,
      idempotencyKey: "interrupted-apply-01",
      ifMatch: studioDraftEtag(fixture.persistence.draft)
    };
    await expect(fixture.service.apply(
      DRAFT_ID,
      request,
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    )).rejects.toMatchObject({
      code: "studio_apply_recovery_required"
    });
    await expect(fixture.service.apply(
      DRAFT_ID,
      request,
      STUDIO_DEFINITION_AUTHORING_APPLY_SCOPE
    )).rejects.toMatchObject({
      code: "studio_apply_recovery_required"
    });
    expect((await fixture.journal.list())[0]?.state).toBe("installing");
  });
});
