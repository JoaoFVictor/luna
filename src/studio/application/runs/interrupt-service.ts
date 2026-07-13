import type {
  InterruptListPage,
  InterruptRecord,
  PagedInterruptStore
} from "../../../core/runtime/interrupts/contracts.js";
import { runStoreError } from "./errors.js";
import { InterruptPageCursorError } from "../../../core/runtime/interrupts/page-cursor.js";
import type { RunCatalogPort } from "./ports.js";
import type { ArtifactReaderPort } from "../artifacts/ports.js";
import type {
  StudioRunInterruptList,
  StudioRunInterruptListQuery,
  StudioRunInterruptResumeReceipt,
  StudioRunInterruptResumeRequest
} from "../../contracts/run-interrupts.js";
import { StudioRunInterruptDecisionSchema } from "../../contracts/run-interrupts.js";

export interface StudioRunInterruptResumePort {
  resume(input: {
    readonly runId: string;
    readonly interrupt: InterruptRecord;
    readonly decision:
      | { readonly action: "approve"; readonly comment?: string }
      | { readonly action: "reject"; readonly comment?: string }
      | {
          readonly action: "request_changes";
          readonly comment: string;
          readonly targets: string[];
        };
  }): Promise<StudioRunInterruptResumeReceipt>;
}

function decisionForPresentation(record: InterruptRecord) {
  const parsed = StudioRunInterruptDecisionSchema.safeParse(
    record.resume?.decision ?? record.resume_input?.decision
  );
  return parsed.success ? parsed.data : undefined;
}

export class StudioRunInterruptService {
  readonly #catalog: Pick<RunCatalogPort, "get">;
  readonly #interrupts: Pick<PagedInterruptStore, "listPage" | "get">;
  readonly #resumer: StudioRunInterruptResumePort;
  readonly #artifacts: Pick<ArtifactReaderPort, "resolveReferences">;

  constructor(options: {
    readonly catalog: Pick<RunCatalogPort, "get">;
    readonly interrupts: Pick<PagedInterruptStore, "listPage" | "get">;
    readonly resumer: StudioRunInterruptResumePort;
    readonly artifacts: Pick<ArtifactReaderPort, "resolveReferences">;
  }) {
    this.#catalog = options.catalog;
    this.#interrupts = options.interrupts;
    this.#resumer = options.resumer;
    this.#artifacts = options.artifacts;
  }

  async list(
    runId: string,
    query: StudioRunInterruptListQuery = {}
  ): Promise<StudioRunInterruptList> {
    if (await this.#catalog.get(runId) === undefined) {
      throw runStoreError("run_not_found", "The requested run does not exist");
    }
    let page: InterruptListPage;
    try {
      page = await this.#interrupts.listPage(runId, {
        limit: query.limit ?? 50,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor })
      });
    } catch (cause) {
      if (cause instanceof InterruptPageCursorError) {
        throw runStoreError("run_cursor_invalid", "The interrupt cursor is invalid");
      }
      throw cause;
    }
    const recordsWithPayload = page.records
      .filter((record) => record.payload !== undefined)
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    const referenceGroups = recordsWithPayload.map(
      (record) => record.payload!.review?.artifact_refs ?? []
    );
    const resolution = await this.#artifacts.resolveReferences(
      runId,
      referenceGroups.flat()
    );
    let matchOffset = 0;
    return {
      run_id: runId,
      next_cursor: page.next_cursor,
      items: recordsWithPayload.map((record, index) => {
        const review = record.payload!.review;
        const referenceCount = referenceGroups[index]!.length;
        const matches = resolution.matches.slice(matchOffset, matchOffset + referenceCount);
        matchOffset += referenceCount;
        const artifacts = matches.flatMap((match) =>
          match.status === "resolved" ? [match.artifact] : []
        );
        const decision = decisionForPresentation(record);
        const materialsReady = review === undefined || (
          matches.length === review.artifact_refs.length &&
          matches.every((match) =>
            match.status === "resolved" && match.artifact.status === "committed"
          )
        );
        const materialsStatus = materialsReady
          ? "ready" as const
          : matches.some((match) => match.status === "resolved" && match.artifact.status === "failed") ||
              record.status === "resolved" || record.status === "cancelled"
            ? "unavailable" as const
            : "pending" as const;
        return {
          interrupt_id: record.id,
          checkpoint_id: record.payload!.checkpoint_id,
          node_id: record.payload!.node_id,
          kind: record.payload!.kind,
          status: record.status,
          prompt: record.payload!.prompt,
          decisions: record.payload!.decisions,
          created_at: record.created_at,
          updated_at: record.updated_at,
          artifacts,
          materials_status: materialsStatus,
          ...(review === undefined ? {} : {
            review: {
              targets: review.targets,
              expected_artifact_count: review.artifact_refs.length
            }
          }),
          ...(decision === undefined ? {} : { decision })
        };
      })
    };
  }

  async resume(
    runId: string,
    interruptId: string,
    request: StudioRunInterruptResumeRequest
  ): Promise<StudioRunInterruptResumeReceipt> {
    const run = await this.#catalog.get(runId);
    if (run === undefined) {
      throw runStoreError("run_not_found", "The requested run does not exist");
    }
    const interrupt = await this.#interrupts.get(interruptId);
    if (interrupt === undefined || interrupt.run_id !== runId || interrupt.payload === undefined) {
      throw runStoreError("run_not_found", "The requested interrupt does not exist");
    }
    const runCanAcceptDecision =
      run.record.run_status === "waiting_for_input" ||
      run.record.run_status === "resuming" ||
      (run.record.run_status === "running" &&
        (interrupt.status === "resuming" || interrupt.status === "resolved"));
    if (!runCanAcceptDecision && interrupt.status !== "resolved") {
      throw runStoreError("run_transition_invalid", "The run is not waiting for input");
    }
    const exactArtifacts = interrupt.payload.review === undefined
      ? { matches: [] }
      : await this.#artifacts.resolveReferences(
          runId,
          interrupt.payload.review.artifact_refs
        );
    if (
      interrupt.payload.review !== undefined &&
      (exactArtifacts.matches.length !== interrupt.payload.review.artifact_refs.length ||
        exactArtifacts.matches.some((match) =>
          match.status === "unresolved" || match.artifact.status !== "committed"
        ))
    ) {
      throw runStoreError("run_transition_invalid", "Review materials are not available yet");
    }
    const comment = request.comment;
    if (request.action === "request_changes") {
      const allowedTargets = new Set(interrupt.payload.review?.targets.map((target) => target.id) ?? []);
      if (
        request.targets.some((target) => !allowedTargets.has(target))
      ) {
        throw runStoreError("run_invalid_input", "The requested review changes are invalid");
      }
    }
    return await this.#resumer.resume({
      runId,
      interrupt,
      decision: request.action === "request_changes"
        ? { action: request.action, comment: request.comment, targets: request.targets }
        : {
            action: request.action,
            ...(comment === undefined ? {} : { comment })
          }
    });
  }
}
