import { describe, expect, it, vi } from "vitest";
import type { InterruptRecord } from "../../../src/core/runtime/interrupts/contracts.js";
import { StudioRunInterruptService } from "../../../src/studio/application/runs/interrupt-service.js";
import type { ArtifactSummary } from "../../../src/studio/contracts/artifacts.js";

const run = {
  record: { run_id: "run-1", run_status: "waiting_for_input" }
};
const interrupt = {
  id: "interrupt-1",
  run_id: "run-1",
  thread_id: "run-1",
  checkpoint_id: "checkpoint-1",
  status: "pending" as const,
  created_at: "2026-07-12T12:00:00.000Z",
  updated_at: "2026-07-12T12:00:00.000Z",
  payload: {
    interrupt_id: "interrupt-1",
    run: { run_id: "run-1", workflow_id: "social-post", attempt: 1, started_at: "2026-07-12T11:59:00.000Z" },
    checkpoint_id: "checkpoint-1",
    node_id: "approval",
    kind: "hitl.approval",
    prompt: "Review",
    decisions: [],
    review: {
      targets: [{ id: "text", label: "Text" }, { id: "image", label: "Image" }],
      artifact_refs: [
        { id: "draft-artifact", uri: "artifact://run-1/draft.json", node_id: "draft" },
        { id: "image-artifact", uri: "artifact://run-1/image.png", node_id: "image" }
      ]
    },
    created_at: "2026-07-12T12:00:00.000Z"
  }
};

const draft = {
  manifest_handle: `ah_${"a".repeat(43)}`,
  name: "draft.json",
  source_node_id: "draft",
  attempt: 1,
  media_type: "application/json",
  status: "committed",
  created_at: "2026-07-12T11:59:30.000Z",
  preview_capability: "probe_required"
} satisfies ArtifactSummary;
const image = {
  ...draft,
  manifest_handle: `ah_${"c".repeat(43)}`,
  name: "image.png",
  source_node_id: "image",
  media_type: "image/png"
} satisfies ArtifactSummary;

function service(options: {
  readonly artifacts?: readonly ArtifactSummary[];
  readonly unresolvedIndexes?: readonly number[];
  readonly record?: InterruptRecord;
} = {}) {
  const record = options.record ?? interrupt;
  const resolved = options.artifacts ?? [draft, image];
  const resumer = { resume: vi.fn(async () => ({ accepted: true as const, run_id: "run-1", interrupt_id: "interrupt-1", resume_status: "succeeded" as const, already_resumed: false })) };
  const listPage = vi.fn(async () => ({ records: [record], next_cursor: null }));
  return {
    value: new StudioRunInterruptService({
      catalog: { get: vi.fn(async () => run as never) },
      interrupts: {
        get: vi.fn(async () => record),
        listPage
      },
      artifacts: {
        resolveReferences: vi.fn(async () => ({
          matches: record.payload!.review!.artifact_refs.map((_reference, index) => {
            if (options.unresolvedIndexes?.includes(index) === true) {
              return { status: "unresolved" as const };
            }
            const artifact = resolved[index];
            return artifact === undefined
              ? { status: "unresolved" as const }
              : { status: "resolved" as const, artifact };
          })
        }))
      },
      resumer
    }),
    resumer,
    listPage
  };
}

describe("StudioRunInterruptService", () => {
  it("resumes a rejected approval with the generic HITL decision", async () => {
    const subject = service();
    await subject.value.resume("run-1", "interrupt-1", { action: "reject", comment: "Not ready" });
    expect(subject.resumer.resume).toHaveBeenCalledWith(expect.objectContaining({
      decision: { action: "reject", comment: "Not ready" }
    }));
  });

  it("resumes an approved HITL decision without workflow-specific content", async () => {
    const subject = service();
    await subject.value.resume("run-1", "interrupt-1", { action: "approve" });
    expect(subject.resumer.resume).toHaveBeenCalledWith(expect.objectContaining({ decision: { action: "approve" } }));
  });

  it("resumes a discriminated change request with declared targets", async () => {
    const subject = service();
    await subject.value.resume("run-1", "interrupt-1", {
      action: "request_changes",
      comment: "Shorten the copy",
      targets: ["text"]
    });
    expect(subject.resumer.resume).toHaveBeenCalledWith(expect.objectContaining({
      decision: {
        action: "request_changes",
        comment: "Shorten the copy",
        targets: ["text"]
      }
    }));
  });

  it("rejects change targets that were not declared by the interrupt", async () => {
    const subject = service();
    await expect(subject.value.resume("run-1", "interrupt-1", {
      action: "request_changes",
      comment: "Change the audio",
      targets: ["audio"]
    })).rejects.toMatchObject({ code: "run_invalid_input" });
  });

  it("returns safe artifact references with the interrupt list", async () => {
    const subject = service();
    const response = await subject.value.list("run-1");
    expect(response).toMatchObject({
      run_id: "run-1",
      next_cursor: null,
      items: [{
        interrupt_id: "interrupt-1",
        prompt: "Review",
        review: {
          targets: interrupt.payload.review.targets,
          expected_artifact_count: 2
        },
        materials_status: "ready",
        artifacts: [draft, image]
      }]
    });
  });

  it("projects a durably claimed asynchronous decision as resuming", async () => {
    const decision = {
      action: "request_changes" as const,
      comment: "Increase contrast",
      targets: ["image"]
    };
    const response = await service({
      record: {
        ...interrupt,
        status: "resuming",
        resume_attempt: "resume-1",
        resume_input: {
          interrupt_id: interrupt.id,
          thread_id: interrupt.thread_id,
          checkpoint_id: interrupt.checkpoint_id,
          decision
        }
      }
    }).value.list("run-1");

    expect(response.items[0]).toMatchObject({
      status: "resuming",
      decision
    });
  });

  it("forwards bounded cursor pagination to the interrupt store", async () => {
    const subject = service();
    await subject.value.list("run-1", { limit: 25, cursor: "opaque-cursor" });
    expect(subject.listPage).toHaveBeenCalledWith("run-1", {
      limit: 25,
      cursor: "opaque-cursor"
    });
  });

  it("binds only artifacts declared for the current review round", async () => {
    const unrelated = {
      ...draft,
      manifest_handle: `ah_${"b".repeat(43)}`,
      name: "trace.json",
      source_node_id: "trace"
    } satisfies ArtifactSummary;
    const response = await service({ artifacts: [draft] }).value.list("run-1");

    expect(response.items[0]?.artifacts).toEqual([draft]);
  });

  it("keeps the review pending and rejects decisions while an exact artifact is unavailable", async () => {
    const subject = service({ artifacts: [draft], unresolvedIndexes: [1] });

    const response = await subject.value.list("run-1");
    expect(response.items[0]).toMatchObject({
      materials_status: "pending",
      artifacts: [draft]
    });
    await expect(subject.value.resume("run-1", "interrupt-1", { action: "approve" }))
      .rejects.toMatchObject({ code: "run_transition_invalid" });
    expect(subject.resumer.resume).not.toHaveBeenCalled();
  });
});
