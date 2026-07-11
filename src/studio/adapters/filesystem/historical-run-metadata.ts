import { z } from "zod";
import { WorkflowIdSchema } from "../../../core/router/invocation.js";
import { StudioDigestSchema } from "../../contracts/digests.js";
import { RunOpaqueIdSchema } from "../../contracts/runs.js";
import {
  openPinnedRunFile,
  pinnedHistoricalRunFileUnchanged,
  pinnedDirectoryTimestamp,
  type PinnedHistoricalRunDirectory
} from "./historical-run-filesystem.js";
import {
  readBoundedJsonlFirstLine,
  readCompleteBoundedFile
} from "./bounded-positioned-read.js";

const TimestampSchema = z.string().datetime({ offset: true });
const BoundedWorkflowIdSchema = WorkflowIdSchema.max(256);
const ExactRunOpaqueIdSchema = z
  .string()
  .refine((value) => value === value.trim(), "Identifier cannot have outer whitespace")
  .pipe(RunOpaqueIdSchema);

const SummaryMetadataSchema = z
  .object({
    schema_version: z.literal(2),
    run_id: ExactRunOpaqueIdSchema,
    workflow_id: BoundedWorkflowIdSchema
  })
  .passthrough();

const TraceMetadataSchema = z
  .object({
    type: z.literal("span.started"),
    span: z
      .object({
        run_id: ExactRunOpaqueIdSchema,
        workflow_id: BoundedWorkflowIdSchema,
        started_at: TimestampSchema,
        attributes: z.record(z.string(), z.unknown()).optional()
      })
      .passthrough()
  })
  .passthrough();

type HistoricalMetadataFragment = {
  readonly runId: string;
  readonly workflowId: string;
};

type TraceMetadata = HistoricalMetadataFragment & {
  readonly startedAt: string;
  readonly workflowRevision?: string;
};

export type HistoricalRunMetadata = {
  readonly runId: string;
  readonly workflowId: string;
  readonly createdAt: string;
  readonly workflowRevision?: string;
};

export type HistoricalRunMetadataOptions = {
  readonly summaryMaxBytes: number;
  readonly traceFirstLineMaxBytes: number;
};

async function readBoundedFile(
  directory: PinnedHistoricalRunDirectory,
  fileName: string,
  maxBytes: number
): Promise<string | undefined> {
  const file = await openPinnedRunFile(directory, fileName);
  if (file === undefined) {
    return undefined;
  }
  try {
    const content = await readCompleteBoundedFile({
      reader: file.handle,
      expectedBytes: file.size,
      maxBytes
    });
    if (content === undefined) {
      return undefined;
    }
    if (!(await pinnedHistoricalRunFileUnchanged(file))) {
      return undefined;
    }
    return content.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

async function readBoundedFirstLine(
  directory: PinnedHistoricalRunDirectory,
  fileName: string,
  maxBytes: number
): Promise<string | undefined> {
  const file = await openPinnedRunFile(directory, fileName);
  if (file === undefined) {
    return undefined;
  }
  try {
    const content = await readBoundedJsonlFirstLine({
      reader: file.handle,
      maxBytes
    });
    if (
      content === undefined ||
      !(await pinnedHistoricalRunFileUnchanged(file))
    ) {
      return undefined;
    }
    return content.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

function parseJson(value: string | undefined): unknown | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function summaryMetadata(value: unknown): HistoricalMetadataFragment | undefined {
  const parsed = SummaryMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return {
    runId: parsed.data.run_id,
    workflowId: parsed.data.workflow_id
  };
}

function traceMetadata(value: unknown): TraceMetadata | undefined {
  const parsed = TraceMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const revision = StudioDigestSchema.safeParse(
    parsed.data.span.attributes?.["luna.workflow.revision"]
  );
  return {
    runId: parsed.data.span.run_id,
    workflowId: parsed.data.span.workflow_id,
    startedAt: parsed.data.span.started_at,
    ...(revision.success ? { workflowRevision: revision.data } : {})
  };
}

function fragmentsAgree(
  expectedRunId: string,
  summary: HistoricalMetadataFragment | undefined,
  trace: TraceMetadata | undefined
): boolean {
  const fragments = [summary, trace].filter(
    (fragment): fragment is HistoricalMetadataFragment => fragment !== undefined
  );
  return fragments.length > 0 && fragments.every((fragment) =>
    fragment.runId === expectedRunId &&
    fragment.workflowId === fragments[0]?.workflowId);
}

export async function readHistoricalRunMetadata(input: {
  readonly directory: PinnedHistoricalRunDirectory;
  readonly expectedRunId: string;
  readonly options: HistoricalRunMetadataOptions;
}): Promise<HistoricalRunMetadata | undefined> {
  const [summary, trace] = await Promise.all([
    readBoundedFile(
      input.directory,
      "observability-summary.json",
      input.options.summaryMaxBytes
    ).then(parseJson).then(summaryMetadata),
    readBoundedFirstLine(
      input.directory,
      "trace.jsonl",
      input.options.traceFirstLineMaxBytes
    ).then(parseJson).then(traceMetadata)
  ]);

  if (!fragmentsAgree(input.expectedRunId, summary, trace)) {
    return undefined;
  }
  const fragment = trace ?? summary;
  if (fragment === undefined) {
    return undefined;
  }
  return {
    runId: fragment.runId,
    workflowId: fragment.workflowId,
    createdAt: trace?.startedAt ?? pinnedDirectoryTimestamp(input.directory),
    ...(trace?.workflowRevision === undefined
      ? {}
      : { workflowRevision: trace.workflowRevision })
  };
}
