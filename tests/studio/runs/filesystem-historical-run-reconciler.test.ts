import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HistoricalRunImport,
  RunLedgerPort,
  RunMutationResult,
  RunReconcilerPort
} from "../../../src/studio/application/runs/ports.js";
import { FilesystemHistoricalRunReconciler } from "../../../src/studio/adapters/filesystem/historical-run-reconciler.js";
import type { RunRecord } from "../../../src/studio/contracts/runs.js";

const REVISION = `sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

function summary(runId: string, workflowId = "external-workflow"): string {
  return JSON.stringify({
    schema_version: 2,
    run_id: runId,
    workflow_id: workflowId,
    trace_id: "private-trace-data",
    tokens: { total: 99 }
  });
}

function trace(runId: string, workflowId = "external-workflow"): string {
  return `${JSON.stringify({
    type: "span.started",
    span: {
      schema_version: 1,
      trace_id: "private-trace-data",
      span_id: "span-1",
      run_id: runId,
      workflow_id: workflowId,
      attempt: 1,
      name: "workflow.run",
      kind: "workflow",
      status: "ok",
      started_at: "2026-07-10T10:11:12.000Z",
      attributes: {
        "luna.workflow.revision": REVISION,
        "private.attribute": "must-not-be-imported"
      },
      metadata: { private: "must-not-be-imported" }
    }
  })}\n${"x".repeat(500_000)}`;
}

async function runDirectory(
  root: string,
  runId: string,
  files: {
    readonly summary?: string;
    readonly trace?: string;
  }
): Promise<string> {
  const directory = path.join(root, runId);
  await mkdir(directory);
  await Promise.all([
    ...(files.summary === undefined
      ? []
      : [writeFile(path.join(directory, "observability-summary.json"), files.summary)]),
    ...(files.trace === undefined
      ? []
      : [writeFile(path.join(directory, "trace.jsonl"), files.trace)])
  ]);
  return directory;
}

function memoryPorts(input?: {
  readonly failRunIds?: ReadonlySet<string>;
  readonly knownRuns?: ReadonlyMap<string, RunRecord>;
}): {
  readonly imports: HistoricalRunImport[];
  readonly reconciler: RunReconcilerPort;
  readonly knownRuns: Pick<RunLedgerPort, "get">;
} {
  const imports: HistoricalRunImport[] = [];
  const imported = new Map<string, RunRecord>(input?.knownRuns);
  return {
    imports,
    knownRuns: {
      async get(runId) {
        return imported.get(runId);
      }
    },
    reconciler: {
      async importHistorical(command): Promise<RunMutationResult> {
        if (input?.failRunIds?.has(command.record.run_id) === true) {
          throw new Error("private /outside/secret-path must not escape");
        }
        imports.push(command);
        const existing = imported.get(command.record.run_id);
        if (existing !== undefined) {
          return {
            record: existing,
            applied: false,
            transition_revision: existing.record_revision,
            catalog_projection_pending: false
          };
        }
        imported.set(command.record.run_id, command.record);
        return {
          record: command.record,
          applied: true,
          transition_revision: command.record.record_revision,
          catalog_projection_pending: false
        };
      }
    }
  };
}

describe("filesystem historical run reconciliation", () => {
  it("imports only minimal validated metadata without claiming a terminal outcome", async () => {
    const root = await temporaryDirectory("luna-historical-runs-");
    await runDirectory(root, "external-run-1", {
      summary: summary("external-run-1"),
      trace: trace("external-run-1")
    });
    const ports = memoryPorts();
    const service = new FilesystemHistoricalRunReconciler({
      root,
      ...ports,
      options: { intervalMs: 3_600_000 }
    });

    const report = await service.initialize();
    await service.close();

    expect(report).toMatchObject({ imported: 1, examinedRunDirectories: 1 });
    expect(ports.imports).toHaveLength(1);
    const command = ports.imports[0];
    expect(command).toMatchObject({
      transition_id: expect.stringMatching(/^historical-import-[a-f0-9]{64}$/),
      event_id: expect.stringMatching(/^historical-event-[a-f0-9]{64}$/),
      record: {
        run_id: "external-run-1",
        workflow_id: "external-workflow",
        workflow_revision: REVISION,
        dispatch_status: "historical_unknown",
        created_at: "2026-07-10T10:11:12.000Z",
        lifecycle_projection: "unknown",
        completeness: "legacy",
        source: "artifact-filesystem"
      }
    });
    expect(command?.record.run_status).toBeUndefined();
    expect(command?.record.finished_at).toBeUndefined();
    expect(command?.record.owner_id).toBeUndefined();
    expect(command?.record.artifact_count).toBeUndefined();
    expect(command?.record.interrupt_count).toBeUndefined();
    expect(JSON.stringify(command)).not.toContain("private-trace-data");
    expect(JSON.stringify(command)).not.toContain("must-not-be-imported");
  });

  it("uses deterministic idempotency ids for the same filesystem evidence", async () => {
    const root = await temporaryDirectory("luna-historical-idempotent-");
    await runDirectory(root, "external-run-idempotent", {
      summary: summary("external-run-idempotent"),
      trace: trace("external-run-idempotent")
    });
    const firstPorts = memoryPorts();
    const secondPorts = memoryPorts();
    const first = new FilesystemHistoricalRunReconciler({
      root,
      ...firstPorts,
      options: { intervalMs: 3_600_000 }
    });
    const second = new FilesystemHistoricalRunReconciler({
      root,
      ...secondPorts,
      options: { intervalMs: 3_600_000 }
    });

    await first.initialize();
    await second.initialize();
    await Promise.all([first.close(), second.close()]);

    expect(firstPorts.imports).toHaveLength(1);
    expect(secondPorts.imports).toEqual(firstPorts.imports);
  });

  it("isolates malformed, oversized, inconsistent, and failed candidates", async () => {
    const root = await temporaryDirectory("luna-historical-isolation-");
    await Promise.all([
      runDirectory(root, "malformed-run", { summary: "{" }),
      runDirectory(root, "oversized-summary", {
        summary: JSON.stringify({
          schema_version: 2,
          run_id: "oversized-summary",
          workflow_id: "external-workflow",
          padding: "x".repeat(2_000)
        })
      }),
      runDirectory(root, "oversized-trace", {
        trace: trace("oversized-trace")
      }),
      runDirectory(root, "inconsistent-run", {
        summary: summary("different-run-id")
      }),
      runDirectory(root, "failed-import", {
        summary: summary("failed-import")
      }),
      runDirectory(root, "valid-after-errors", {
        summary: summary("valid-after-errors")
      })
    ]);
    const ports = memoryPorts({ failRunIds: new Set(["failed-import"]) });
    const reportDiagnostic = vi.fn();
    const service = new FilesystemHistoricalRunReconciler({
      root,
      ...ports,
      diagnostics: { report: reportDiagnostic },
      options: {
        intervalMs: 3_600_000,
        summaryMaxBytes: 256,
        traceFirstLineMaxBytes: 256
      }
    });

    const report = await service.initialize();
    await service.close();

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(5);
    expect(ports.imports.map((item) => item.record.run_id)).toEqual([
      "valid-after-errors"
    ]);
    expect(JSON.stringify(report)).not.toContain("secret-path");
    expect(reportDiagnostic).toHaveBeenCalledWith({
      code: "historical_import_failed",
      component: "historical_reconciler",
      occurred_at: expect.any(String),
      run_id: "failed-import"
    });
    expect(JSON.stringify(reportDiagnostic.mock.calls)).not.toContain("/outside/");
  });

  it("does not follow run-directory or metadata-file symlinks", async () => {
    const root = await temporaryDirectory("luna-historical-symlinks-");
    const outside = await temporaryDirectory("luna-historical-outside-");
    const outsideRun = await runDirectory(outside, "symlink-directory", {
      summary: summary("symlink-directory")
    });
    await symlink(outsideRun, path.join(root, "symlink-directory"), "dir");
    const linkedMetadata = path.join(outside, "linked-summary.json");
    await writeFile(linkedMetadata, summary("symlink-metadata"));
    const metadataDirectory = await runDirectory(root, "symlink-metadata", {});
    await symlink(
      linkedMetadata,
      path.join(metadataDirectory, "observability-summary.json"),
      "file"
    );
    await runDirectory(root, "safe-run", { summary: summary("safe-run") });
    const ports = memoryPorts();
    const service = new FilesystemHistoricalRunReconciler({
      root,
      ...ports,
      options: { intervalMs: 3_600_000 }
    });

    const report = await service.initialize();
    await service.close();

    expect(report.imported).toBe(1);
    expect(ports.imports.map((item) => item.record.run_id)).toEqual(["safe-run"]);
  });

  it("bounds each pass and discovers new runs while active, then stops cleanly", async () => {
    const root = await temporaryDirectory("luna-historical-live-");
    await Promise.all([
      runDirectory(root, "bounded-run-1", { summary: summary("bounded-run-1") }),
      runDirectory(root, "bounded-run-2", { summary: summary("bounded-run-2") }),
      runDirectory(root, "bounded-run-3", { summary: summary("bounded-run-3") })
    ]);
    const boundedPorts = memoryPorts();
    const bounded = new FilesystemHistoricalRunReconciler({
      root,
      ...boundedPorts,
      options: {
        intervalMs: 3_600_000,
        maxRootEntries: 2,
        maxRunDirectories: 2
      }
    });
    const boundedReport = await bounded.initialize();
    const nextBoundedReport = await bounded.reconcileNow();
    await bounded.close();
    expect(boundedReport.examinedEntries).toBe(2);
    expect(boundedReport.examinedRunDirectories).toBe(2);
    expect(nextBoundedReport.examinedEntries).toBe(1);
    expect(boundedPorts.imports).toHaveLength(3);

    const liveRoot = await temporaryDirectory("luna-historical-live-new-");
    const livePorts = memoryPorts();
    const live = new FilesystemHistoricalRunReconciler({
      root: liveRoot,
      ...livePorts,
      options: { intervalMs: 10 }
    });
    await live.initialize();
    await runDirectory(liveRoot, "created-while-active", {
      summary: summary("created-while-active")
    });
    await vi.waitFor(
      () => expect(livePorts.imports).toHaveLength(1),
      { timeout: 1_000, interval: 10 }
    );
    await live.close();
    const importsAfterClose = livePorts.imports.length;
    await runDirectory(liveRoot, "created-after-close", {
      summary: summary("created-after-close")
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(livePorts.imports).toHaveLength(importsAfterClose);
  });

  it("pins the root and run directory across an adversarial root swap", async () => {
    const root = await temporaryDirectory("luna-historical-root-race-");
    const outside = await temporaryDirectory("luna-historical-root-race-outside-");
    const movedRoot = `${root}-moved`;
    await runDirectory(root, "root-race", {
      summary: summary("root-race", "inside-workflow")
    });
    await runDirectory(outside, "root-race", {
      summary: summary("root-race", "outside-workflow")
    });
    const ports = memoryPorts();
    let swapped = false;
    const service = new FilesystemHistoricalRunReconciler({
      root,
      reconciler: ports.reconciler,
      knownRuns: {
        async get(runId) {
          if (!swapped) {
            swapped = true;
            await rename(root, movedRoot);
            await symlink(outside, root, "dir");
          }
          return await ports.knownRuns.get(runId);
        }
      },
      options: { intervalMs: 3_600_000 }
    });

    try {
      await service.initialize();
      expect(ports.imports).toHaveLength(1);
      expect(ports.imports[0]?.record.workflow_id).toBe("inside-workflow");
      expect(ports.imports[0]?.record.workflow_id).not.toBe("outside-workflow");
    } finally {
      await service.close();
      await rm(root, { force: true });
      await rename(movedRoot, root);
    }
  });

  it("shares close completion and retries a run whose metadata appears later", async () => {
    const closeRoot = await temporaryDirectory("luna-historical-close-");
    await runDirectory(closeRoot, "blocked-import", {
      summary: summary("blocked-import")
    });
    let releaseImport: (() => void) | undefined;
    let importedCommand: HistoricalRunImport | undefined;
    const importStarted = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const blocked = new FilesystemHistoricalRunReconciler({
      root: closeRoot,
      knownRuns: { async get() { return undefined; } },
      reconciler: {
        async importHistorical(command) {
          importedCommand = command;
          await importStarted;
          return {
            record: command.record,
            applied: true,
            transition_revision: 1,
            catalog_projection_pending: false
          };
        }
      },
      options: { intervalMs: 3_600_000 }
    });
    const initialization = blocked.initialize();
    await vi.waitFor(() => expect(importedCommand).toBeDefined());
    let firstClosed = false;
    let secondClosed = false;
    const firstClose = blocked.close().then(() => { firstClosed = true; });
    const secondClose = blocked.close().then(() => { secondClosed = true; });
    await Promise.resolve();
    expect({ firstClosed, secondClosed }).toEqual({
      firstClosed: false,
      secondClosed: false
    });
    releaseImport?.();
    await Promise.all([initialization, firstClose, secondClose]);
    expect({ firstClosed, secondClosed }).toEqual({
      firstClosed: true,
      secondClosed: true
    });

    const pendingRoot = await temporaryDirectory("luna-historical-pending-");
    await runDirectory(pendingRoot, "metadata-later", {});
    const pendingPorts = memoryPorts();
    const pending = new FilesystemHistoricalRunReconciler({
      root: pendingRoot,
      ...pendingPorts,
      options: {
        intervalMs: 10,
        pendingRetryBaseMs: 10
      }
    });
    await pending.initialize();
    await writeFile(
      path.join(pendingRoot, "metadata-later", "observability-summary.json"),
      summary("metadata-later")
    );
    await vi.waitFor(
      () => expect(pendingPorts.imports).toHaveLength(1),
      { timeout: 1_000, interval: 10 }
    );
    await pending.close();
  });

  it("does not bypass a pending candidate's retry backoff through the root scan", async () => {
    const root = await temporaryDirectory("luna-historical-backoff-");
    await runDirectory(root, "metadata-after-backoff", {});
    const ports = memoryPorts();
    let nowMs = Date.parse("2026-07-10T10:11:12.000Z");
    const service = new FilesystemHistoricalRunReconciler({
      root,
      ...ports,
      now: () => new Date(nowMs),
      options: {
        intervalMs: 3_600_000,
        pendingRetryBaseMs: 1_000
      }
    });

    await service.initialize();
    await writeFile(
      path.join(
        root,
        "metadata-after-backoff",
        "observability-summary.json"
      ),
      summary("metadata-after-backoff")
    );

    const beforeBackoff = await service.reconcileNow();
    expect(beforeBackoff.examinedRunDirectories).toBe(0);
    expect(ports.imports).toHaveLength(0);

    nowMs += 1_000;
    const afterBackoff = await service.reconcileNow();
    await service.close();

    expect(afterBackoff).toMatchObject({
      imported: 1,
      examinedRunDirectories: 1
    });
    expect(ports.imports.map((item) => item.record.run_id)).toEqual([
      "metadata-after-backoff"
    ]);
  });

  it("does not let a permanently pending retry starve the root cursor", async () => {
    const root = await temporaryDirectory("luna-historical-fairness-");
    await runDirectory(root, "permanently-pending", {});
    const ports = memoryPorts();
    let nowMs = Date.parse("2026-07-10T10:11:12.000Z");
    const service = new FilesystemHistoricalRunReconciler({
      root,
      ...ports,
      now: () => new Date(nowMs),
      options: {
        intervalMs: 3_600_000,
        maxRunDirectories: 1,
        pendingRetryBatchSize: 1,
        pendingRetryBaseMs: 10
      }
    });

    await service.initialize();
    await runDirectory(root, "new-valid-run", {
      summary: summary("new-valid-run")
    });

    for (let pass = 0; pass < 4 && ports.imports.length === 0; pass += 1) {
      nowMs += 3_600_000;
      await service.reconcileNow();
    }
    await service.close();

    expect(ports.imports.map((item) => item.record.run_id)).toContain(
      "new-valid-run"
    );
  });
});
