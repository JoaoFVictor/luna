export type StudioRunDiagnosticCode =
  | "dispatch_heartbeat_failed"
  | "dispatch_recovery_failed"
  | "dispatch_terminal_cleanup_failed"
  | "dispatch_execution_failed"
  | "historical_scan_failed"
  | "historical_lookup_failed"
  | "historical_import_failed";

export type StudioRunDiagnostic = {
  readonly code: StudioRunDiagnosticCode;
  readonly component: "dispatcher" | "historical_reconciler";
  readonly occurred_at: string;
  readonly run_id?: string;
};

export interface StudioRunDiagnosticSink {
  report(diagnostic: StudioRunDiagnostic): void | Promise<void>;
}

export function reportStudioRunDiagnosticBestEffort(
  sink: StudioRunDiagnosticSink | undefined,
  diagnostic: StudioRunDiagnostic
): void {
  try {
    const operation = sink?.report(diagnostic);
    if (operation !== undefined) {
      void Promise.resolve(operation).catch(() => undefined);
    }
  } catch {
    // Diagnostics must never change run or reconciliation semantics.
  }
}

export function createProcessWarningRunDiagnosticSink(): StudioRunDiagnosticSink {
  const reported = new Set<string>();
  return {
    report(diagnostic) {
      const key = [
        diagnostic.component,
        diagnostic.code,
        diagnostic.run_id ?? ""
      ].join(":");
      if (reported.has(key)) {
        return;
      }
      reported.add(key);
      if (reported.size > 1_024) {
        const oldest = reported.values().next().value as string | undefined;
        if (oldest !== undefined) {
          reported.delete(oldest);
        }
      }
      process.emitWarning(
        `Luna Studio run diagnostic: ${diagnostic.component}/${diagnostic.code}`,
        { code: "LUNA_STUDIO_RUN_DIAGNOSTIC" }
      );
    }
  };
}
