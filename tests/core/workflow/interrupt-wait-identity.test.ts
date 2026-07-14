import { describe, expect, it } from "vitest";
import {
  checkpointId,
  checkpointIdCandidates,
  interruptId,
  interruptIdMatches,
  legacyCheckpointId,
  legacyInterruptId
} from "../../../src/runtime/workflow/interrupt-wait-protocol.js";

describe("interrupt wait durable identity", () => {
  it("keeps a loop occurrence disjoint from a valid hyphenated node id", () => {
    const runId = "run-social-post";
    const plainInterrupt = interruptId(runId, "editorial-iteration-1");
    const loopInterrupt = interruptId(runId, "editorial", "iteration-1");
    const plainCheckpoint = checkpointId(runId, "editorial-iteration-1");
    const loopCheckpoint = checkpointId(runId, "editorial", "iteration-1");

    expect(loopInterrupt).not.toBe(plainInterrupt);
    expect(loopCheckpoint).not.toBe(plainCheckpoint);
    expect(loopInterrupt).toMatch(/^interrupt-v2-[a-f0-9]{64}$/);
    expect(loopCheckpoint).toMatch(/^checkpoint-v2-[a-f0-9]{64}$/);

    expect(legacyInterruptId(runId, "editorial", "iteration-1")).toBe(
      plainInterrupt
    );
    expect(legacyCheckpointId(runId, "editorial", "iteration-1")).toBe(
      plainCheckpoint
    );
  });

  it("recognizes a persisted legacy loop interrupt during recovery", () => {
    const legacy = legacyInterruptId(
      "run-social-post",
      "editorial",
      "iteration-10"
    );

    expect(interruptIdMatches(
      legacy,
      "run-social-post",
      "editorial",
      "iteration-10"
    )).toBe(true);
    expect(checkpointIdCandidates(
      "run-social-post",
      "editorial",
      "iteration-10"
    )).toContain(legacyCheckpointId(
      "run-social-post",
      "editorial",
      "iteration-10"
    ));
  });
});
