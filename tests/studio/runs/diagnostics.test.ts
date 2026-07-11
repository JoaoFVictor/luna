import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProcessWarningRunDiagnosticSink,
  reportStudioRunDiagnosticBestEffort
} from "../../../src/studio/application/runs/diagnostics.js";

const DIAGNOSTIC = {
  code: "historical_import_failed",
  component: "historical_reconciler",
  occurred_at: "2026-07-11T12:00:00.000Z",
  run_id: "private-run-id"
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Studio run diagnostics", () => {
  it("redacts identifiers and deduplicates process warnings", () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(
      () => undefined
    );
    const sink = createProcessWarningRunDiagnosticSink();

    sink.report(DIAGNOSTIC);
    sink.report(DIAGNOSTIC);

    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).toContain(
      "historical_reconciler/historical_import_failed"
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-run-id");
  });

  it("isolates synchronous and asynchronous sink failures", async () => {
    expect(() => reportStudioRunDiagnosticBestEffort({
      report() {
        throw new Error("sink failed");
      }
    }, DIAGNOSTIC)).not.toThrow();

    reportStudioRunDiagnosticBestEffort({
      report: async () => {
        throw new Error("async sink failed");
      }
    }, DIAGNOSTIC);
    await Promise.resolve();
    await Promise.resolve();
  });
});
