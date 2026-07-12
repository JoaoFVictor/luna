import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemStudioApplyJournal } from "../../../src/studio/adapters/filesystem/apply-journal.js";
import {
  FileSystemStudioApplyTransaction,
  createStudioApplyWorkspaceFaultAdapter,
  type StudioApplyFaultInjector,
  type StudioApplyFaultStage
} from "../../../src/studio/adapters/filesystem/apply-transaction.js";
import {
  FileSystemStudioApplySource,
  StudioApplyPathResolver
} from "../../../src/studio/adapters/filesystem/apply-paths.js";
import { StudioApplyWorkspace } from "../../../src/studio/adapters/filesystem/apply-workspace.js";
import {
  studioApplyBytesDigest,
  studioApplySecretDigest,
  studioApplyValueDigest
} from "../../../src/studio/application/apply/digests.js";
import { StudioApplySimulatedCrash } from "../../../src/studio/application/apply/errors.js";
import type {
  StudioApplyTransactionEntry,
  StudioApplyTransactionInput,
  StudioInstalledApplyVerificationPort
} from "../../../src/studio/application/apply/ports.js";
import type { StudioPath } from "../../../src/studio/contracts/paths.js";

const temporaryRoots: string[] = [];
const CATALOG_DIGEST = studioApplyValueDigest({ catalog: "test" });
const RESOURCE_REVISION = studioApplyValueDigest({ workflow: "demo-v2" });

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

function writeEntry(
  file: StudioPath,
  before: string | undefined,
  after: string,
  mode = 0o644,
  beforeMode = 0o644
): StudioApplyTransactionEntry {
  const content = Buffer.from(after, "utf8");
  return {
    file,
    action: "write",
    beforeSha256:
      before === undefined
        ? null
        : studioApplyBytesDigest(Buffer.from(before, "utf8")),
    beforeMode: before === undefined ? null : beforeMode,
    afterSha256: studioApplyBytesDigest(content),
    content,
    mode
  };
}

function deleteEntry(
  file: StudioPath,
  before: string
): StudioApplyTransactionEntry {
  return {
    file,
    action: "delete",
    beforeSha256: studioApplyBytesDigest(Buffer.from(before, "utf8")),
    beforeMode: 0o644,
    afterSha256: null
  };
}

function transactionInput(
  entries: readonly StudioApplyTransactionEntry[],
  operationId = randomUUID()
): StudioApplyTransactionInput {
  const draftHash = studioApplyValueDigest({ operationId, draft: "demo" });
  return {
    operationId,
    draftId: "11111111-1111-4111-8111-111111111111",
    recordRevision: 3,
    draftHash,
    requestHash: studioApplyValueDigest({ operationId, request: true }),
    idempotencyKeyHash: studioApplySecretDigest(`idempotency-${operationId}`),
    planTokenHash: studioApplySecretDigest(`plan-token-${operationId}`),
    planDigest: studioApplyValueDigest({ operationId, plan: true }),
    allowedFiles: entries.map((entry) => entry.file),
    entries,
    guards: entries.map((entry) => ({
      file: entry.file,
      sha256: entry.beforeSha256,
      mode: entry.beforeMode
    })),
    diff: entries.map((entry) => ({
      file: entry.file,
      kind:
        entry.action === "delete"
          ? "deleted"
          : entry.beforeSha256 === null
            ? "created"
            : "modified",
      before_sha256: entry.beforeSha256,
      after_sha256: entry.afterSha256,
      before_mode: entry.beforeMode,
      after_mode: entry.mode ?? null,
      textual_diff: "redacted diff",
      textual_diff_truncated: false,
      redacted: true
    })),
    verification: {
      resources: [{ kind: "workflow", id: "demo" }],
      expectedResourceRevisions: { "workflow:demo": RESOURCE_REVISION },
      technicalCatalogFingerprint: CATALOG_DIGEST,
      compilerContractVersion: "test-compiler-v1"
    }
  };
}

function verifier(): StudioInstalledApplyVerificationPort {
  return {
    verify: async () => ({ "workflow:demo": RESOURCE_REVISION })
  };
}

function createTransaction(options: {
  projectRoot: string;
  configRoot: string;
  faultInjector?: StudioApplyFaultInjector;
}) {
  const resolver = new StudioApplyPathResolver({
    project: options.projectRoot,
    config: options.configRoot
  });
  const source = new FileSystemStudioApplySource(resolver);
  const journal = new FileSystemStudioApplyJournal({
    projectRoot: options.projectRoot
  });
  const workspace = new StudioApplyWorkspace({
    resolver,
    source,
    maxFileBytes: 1024 * 1024,
    faultInjector: createStudioApplyWorkspaceFaultAdapter(
      options.faultInjector
    )
  });
  return {
    journal,
    transaction: new FileSystemStudioApplyTransaction({
      journal,
      workspace,
      faultInjector: options.faultInjector
    })
  };
}

async function prepareSingleFile() {
  const projectRoot = await temporaryRoot("luna-studio-apply-project-");
  const configRoot = await temporaryRoot("luna-studio-apply-config-");
  await mkdir(path.join(projectRoot, "workflows", "demo"), {
    recursive: true
  });
  const file: StudioPath = {
    root: "project",
    path: "workflows/demo/workflow.yaml"
  };
  const target = path.join(projectRoot, ...file.path.split("/"));
  await writeFile(target, "name: old\n", { mode: 0o644 });
  return {
    projectRoot,
    configRoot,
    file,
    target,
    input: transactionInput([
      writeEntry(file, "name: old\n", "name: new\n")
    ])
  };
}

describe("FileSystemStudioApplyTransaction", () => {
  it("commits a deterministic multi-root change set and preserves auxiliary files", async () => {
    const projectRoot = await temporaryRoot("luna-studio-apply-project-");
    const configRoot = await temporaryRoot("luna-studio-apply-config-");
    await mkdir(path.join(projectRoot, "workflows", "demo"), {
      recursive: true
    });
    await mkdir(path.join(configRoot, "settings"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "workflows", "demo", "workflow.yaml"),
      "name: old\n"
    );
    await writeFile(
      path.join(projectRoot, "workflows", "demo", "notes.md"),
      "keep me\n"
    );
    await writeFile(
      path.join(configRoot, "settings", "demo.yaml"),
      "enabled: true\n"
    );
    const entries = [
      writeEntry(
        { root: "project", path: "workflows/demo/workflow.yaml" },
        "name: old\n",
        "name: new\n",
        0o640
      ),
      deleteEntry(
        { root: "config", path: "settings/demo.yaml" },
        "enabled: true\n"
      ),
      writeEntry(
        { root: "project", path: "agents/new/instructions.md" },
        undefined,
        "Do useful work.\n"
      )
    ];
    const input = transactionInput(entries);
    const { journal, transaction } = createTransaction({
      projectRoot,
      configRoot
    });

    const result = await transaction.execute(input, verifier());
    expect(result.status).toBe("committed");
    expect(await readFile(
      path.join(projectRoot, "workflows", "demo", "workflow.yaml"),
      "utf8"
    )).toBe("name: new\n");
    expect(
      (await stat(path.join(projectRoot, "workflows", "demo", "workflow.yaml"))).mode &
        0o777
    ).toBe(0o640);
    await expect(
      readFile(path.join(configRoot, "settings", "demo.yaml"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(
      path.join(projectRoot, "agents", "new", "instructions.md"),
      "utf8"
    )).toBe("Do useful work.\n");
    expect(await readFile(
      path.join(projectRoot, "workflows", "demo", "notes.md"),
      "utf8"
    )).toBe("keep me\n");

    const stored = await journal.get(input.operationId);
    expect(stored?.state).toBe("committed");
    expect(
      await transaction.findByIdempotencyKeyHash(input.idempotencyKeyHash)
    ).toMatchObject({
      operationId: input.operationId,
      state: "committed"
    });
  });

  it("rolls back when a read-only base file mode changes after authorization", async () => {
    const fixture = await prepareSingleFile();
    const readOnlyFile: StudioPath = {
      root: "project",
      path: "workflows/demo/config.schema.json"
    };
    const readOnlyTarget = path.join(
      fixture.projectRoot,
      ...readOnlyFile.path.split("/")
    );
    const readOnlyContent = "{}\n";
    await writeFile(readOnlyTarget, readOnlyContent, { mode: 0o644 });
    const input: StudioApplyTransactionInput = {
      ...fixture.input,
      guards: [
        ...fixture.input.guards,
        {
          file: readOnlyFile,
          sha256: studioApplyBytesDigest(Buffer.from(readOnlyContent, "utf8")),
          mode: 0o644
        }
      ]
    };
    let changed = false;
    const { journal, transaction } = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      faultInjector: async (stage) => {
        if (!changed && stage === "after_prepared") {
          changed = true;
          await chmod(readOnlyTarget, 0o600);
        }
      }
    });

    await expect(transaction.execute(input, verifier())).rejects.toMatchObject({
      code: "studio_apply_rolled_back"
    });
    expect(await readFile(fixture.target, "utf8")).toBe("name: old\n");
    expect((await stat(readOnlyTarget)).mode & 0o777).toBe(0o600);
    expect((await journal.get(input.operationId))?.state).toBe("rolled_back");
  });

  it("rejects logical cross-root aliases before creating a journal", async () => {
    const projectRoot = await temporaryRoot("luna-studio-apply-project-");
    const configRoot = path.join(projectRoot, "config");
    await mkdir(configRoot, { recursive: true });
    const target = path.join(configRoot, "settings.yaml");
    await writeFile(target, "value: old\n", { mode: 0o644 });
    const input = transactionInput([
      writeEntry(
        { root: "project", path: "config/settings.yaml" },
        "value: old\n",
        "value: project\n"
      ),
      writeEntry(
        { root: "config", path: "settings.yaml" },
        "value: old\n",
        "value: config\n"
      )
    ]);
    const { journal, transaction } = createTransaction({
      projectRoot,
      configRoot
    });

    await expect(transaction.execute(input, verifier())).rejects.toMatchObject({
      code: "studio_apply_path_invalid"
    });
    expect(await journal.get(input.operationId)).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("value: old\n");
  });

  it.each<{
    stage: StudioApplyFaultStage;
    expected: "old" | "new";
  }>([
    { stage: "after_prepared", expected: "old" },
    { stage: "after_staging", expected: "old" },
    { stage: "after_backup_entry", expected: "old" },
    { stage: "after_backed_up", expected: "old" },
    { stage: "after_installing", expected: "old" },
    { stage: "after_install_entry", expected: "new" },
    { stage: "after_verifying", expected: "new" },
    { stage: "after_committed", expected: "new" }
  ])("recovers a crash at $stage without partial success", async ({ stage, expected }) => {
    const fixture = await prepareSingleFile();
    let crashed = false;
    const faultInjector: StudioApplyFaultInjector = (currentStage) => {
      if (!crashed && currentStage === stage) {
        crashed = true;
        throw new StudioApplySimulatedCrash();
      }
    };
    const first = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      faultInjector
    });
    await expect(
      first.transaction.execute(fixture.input, verifier())
    ).rejects.toMatchObject({ code: "studio_apply_recovery_required" });

    const restarted = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot
    });
    const recovery = await restarted.transaction.recover(verifier());
    expect(recovery.recoveryRequired).toEqual([]);
    expect(await readFile(fixture.target, "utf8")).toBe(
      expected === "new" ? "name: new\n" : "name: old\n"
    );
    const stored = await restarted.journal.get(fixture.input.operationId);
    expect(stored?.state).toBe(expected === "new" ? "committed" : "rolled_back");
  });

  it("refuses a new transaction while an earlier operation requires recovery", async () => {
    const fixture = await prepareSingleFile();
    let crashed = false;
    const first = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      faultInjector: (stage) => {
        if (!crashed && stage === "after_prepared") {
          crashed = true;
          throw new StudioApplySimulatedCrash();
        }
      }
    });
    await expect(
      first.transaction.execute(fixture.input, verifier())
    ).rejects.toMatchObject({ code: "studio_apply_recovery_required" });

    const secondInput = transactionInput([
      writeEntry(fixture.file, "name: old\n", "name: later\n")
    ]);
    const second = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot
    });
    await expect(
      second.transaction.execute(secondInput, verifier())
    ).rejects.toMatchObject({
      code: "studio_apply_recovery_required",
      details: {
        operationId: fixture.input.operationId,
        state: "prepared"
      }
    });
    expect(await second.journal.get(secondInput.operationId)).toBeUndefined();
    expect(await readFile(fixture.target, "utf8")).toBe("name: old\n");
  });

  it("rolls back a crash after only one of two targets was installed", async () => {
    const fixture = await prepareSingleFile();
    const secondFile: StudioPath = {
      root: "project",
      path: "workflows/demo/second.yaml"
    };
    const secondTarget = path.join(fixture.projectRoot, ...secondFile.path.split("/"));
    await writeFile(secondTarget, "value: old\n");
    const input = transactionInput([
      writeEntry(fixture.file, "name: old\n", "name: new\n"),
      writeEntry(secondFile, "value: old\n", "value: new\n")
    ]);
    let crashed = false;
    const faultInjector: StudioApplyFaultInjector = (stage) => {
      if (!crashed && stage === "after_install_entry") {
        crashed = true;
        throw new StudioApplySimulatedCrash();
      }
    };
    const first = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      faultInjector
    });
    await expect(first.transaction.execute(input, verifier())).rejects.toMatchObject({
      code: "studio_apply_recovery_required"
    });
    const restarted = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot
    });
    const recovery = await restarted.transaction.recover(verifier());
    expect(recovery.recovered).toEqual([input.operationId]);
    expect(await readFile(fixture.target, "utf8")).toBe("name: old\n");
    expect(await readFile(secondTarget, "utf8")).toBe("value: old\n");
  });

  it("preserves an external edit and records recovery_required", async () => {
    const fixture = await prepareSingleFile();
    let crashed = false;
    const first = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      faultInjector: (stage) => {
        if (!crashed && stage === "after_install_entry") {
          crashed = true;
          throw new StudioApplySimulatedCrash();
        }
      }
    });
    await expect(
      first.transaction.execute(fixture.input, verifier())
    ).rejects.toMatchObject({ code: "studio_apply_recovery_required" });
    await writeFile(fixture.target, "name: external\n");

    const restarted = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot
    });
    const recovery = await restarted.transaction.recover(verifier());
    expect(recovery.recoveryRequired).toEqual([fixture.input.operationId]);
    expect(await readFile(fixture.target, "utf8")).toBe("name: external\n");
    expect((await restarted.journal.get(fixture.input.operationId))?.state).toBe(
      "recovery_required"
    );
  });

  it("preserves an external mode edit and records recovery_required", async () => {
    const fixture = await prepareSingleFile();
    let crashed = false;
    const first = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      faultInjector: (stage) => {
        if (!crashed && stage === "after_install_entry") {
          crashed = true;
          throw new StudioApplySimulatedCrash();
        }
      }
    });
    await expect(
      first.transaction.execute(fixture.input, verifier())
    ).rejects.toMatchObject({ code: "studio_apply_recovery_required" });
    await chmod(fixture.target, 0o600);

    const restarted = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot
    });
    const recovery = await restarted.transaction.recover(verifier());
    expect(recovery.recoveryRequired).toEqual([fixture.input.operationId]);
    expect(await readFile(fixture.target, "utf8")).toBe("name: new\n");
    expect((await stat(fixture.target)).mode & 0o777).toBe(0o600);
  });

  it.each(["after_rolling_back", "after_rolled_back"] as const)(
    "recovers a crash at the %s rollback transition",
    async (faultStage) => {
      const fixture = await prepareSingleFile();
      let crashed = false;
      const failingVerifier: StudioInstalledApplyVerificationPort = {
        verify: async () => {
          throw new Error("verification failed");
        }
      };
      const first = createTransaction({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot,
        faultInjector: (stage) => {
          if (!crashed && stage === faultStage) {
            crashed = true;
            throw new StudioApplySimulatedCrash();
          }
        }
      });
      await expect(
        first.transaction.execute(fixture.input, failingVerifier)
      ).rejects.toMatchObject({ code: "studio_apply_recovery_required" });

      const restarted = createTransaction({
        projectRoot: fixture.projectRoot,
        configRoot: fixture.configRoot
      });
      const recovery = await restarted.transaction.recover(verifier());
      expect(recovery.recoveryRequired).toEqual([]);
      expect(await readFile(fixture.target, "utf8")).toBe("name: old\n");
      expect((await restarted.journal.get(fixture.input.operationId))?.state).toBe(
        "rolled_back"
      );
    }
  );

  it("keeps recovery_required durable when recovery marking is interrupted", async () => {
    const fixture = await prepareSingleFile();
    let injected = false;
    const first = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      faultInjector: async (stage) => {
        if (stage === "after_verifying") {
          await writeFile(fixture.target, "name: external\n");
        }
        if (!injected && stage === "after_recovery_required") {
          injected = true;
          throw new StudioApplySimulatedCrash();
        }
      }
    });
    await expect(
      first.transaction.execute(fixture.input, verifier())
    ).rejects.toMatchObject({ code: "studio_apply_recovery_required" });
    expect((await first.journal.get(fixture.input.operationId))?.state).toBe(
      "recovery_required"
    );
    expect(await readFile(fixture.target, "utf8")).toBe("name: external\n");
  });

  it("detects a parent symlink swap between staging and backup", async () => {
    const fixture = await prepareSingleFile();
    const outside = await temporaryRoot("luna-studio-apply-outside-");
    await writeFile(path.join(outside, "workflow.yaml"), "name: outside\n");
    const originalParent = path.dirname(fixture.target);
    const displacedParent = `${originalParent}-displaced`;
    let swapped = false;
    const first = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot,
      faultInjector: async (stage) => {
        if (!swapped && stage === "after_staging") {
          swapped = true;
          await rename(originalParent, displacedParent);
          await symlink(outside, originalParent);
        }
      }
    });
    await expect(
      first.transaction.execute(fixture.input, verifier())
    ).rejects.toMatchObject({ code: "studio_apply_recovery_required" });
    expect(await readFile(path.join(outside, "workflow.yaml"), "utf8")).toBe(
      "name: outside\n"
    );
    expect(await readFile(path.join(displacedParent, "workflow.yaml"), "utf8")).toBe(
      "name: old\n"
    );
  });

  it("rejects an ancestor symlink without touching its external target", async () => {
    const projectRoot = await temporaryRoot("luna-studio-apply-project-");
    const configRoot = await temporaryRoot("luna-studio-apply-config-");
    const outside = await temporaryRoot("luna-studio-apply-outside-");
    await writeFile(path.join(outside, "workflow.yaml"), "name: outside\n");
    await symlink(outside, path.join(projectRoot, "workflows"));
    const resolver = new StudioApplyPathResolver({ project: projectRoot, config: configRoot });
    const source = new FileSystemStudioApplySource(resolver);
    await expect(
      source.read(
        { root: "project", path: "workflows/workflow.yaml" },
        { maxBytes: 1024 }
      )
    ).rejects.toMatchObject({ code: "studio_apply_path_invalid" });
    expect(await readFile(path.join(outside, "workflow.yaml"), "utf8")).toBe(
      "name: outside\n"
    );
  });

  it("retains executable mode only when explicitly planned", async () => {
    const fixture = await prepareSingleFile();
    await chmod(fixture.target, 0o755);
    const input = transactionInput([
      writeEntry(fixture.file, "name: old\n", "name: new\n", 0o755, 0o755)
    ]);
    const { transaction } = createTransaction({
      projectRoot: fixture.projectRoot,
      configRoot: fixture.configRoot
    });
    await transaction.execute(input, verifier());
    expect((await stat(fixture.target)).mode & 0o777).toBe(0o755);
  });
});
