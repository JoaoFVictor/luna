import { describe, expect, it } from "vitest";
import {
  STUDIO_RESOURCE_HISTORY_ERROR_CODES,
  StudioResourceHistoryError
} from "../../../src/studio/application/history/errors.js";
import { studioDomainHttpError } from "../../../src/studio/server/domain-error.js";

describe("Studio resource history HTTP errors", () => {
  it("maps every history failure without publishing Git diagnostics", () => {
    const canary = "/private/repository/.git: fatal: authorization secret";

    for (const code of STUDIO_RESOURCE_HISTORY_ERROR_CODES) {
      const projected = studioDomainHttpError(
        new StudioResourceHistoryError(code, canary, {
          cause: new Error(canary),
          details: {
            resource: { kind: "agent", id: "reviewer" },
            actualBytes: 12_345,
            maxBytes: 10
          }
        })
      );
      expect(projected, code).toBeDefined();
      expect(projected?.code).toBe(code);
      expect(projected?.message).not.toContain(canary);
      expect(projected?.details).toBeUndefined();
      expect(projected?.statusCode).toBeGreaterThanOrEqual(400);
      expect(projected?.statusCode).toBeLessThan(600);
    }
  });

  it("uses stable semantics for unavailable, missing, and oversized history", () => {
    expect(
      studioDomainHttpError(
        new StudioResourceHistoryError("studio_history_unavailable", "unsafe")
      )
    ).toMatchObject({ statusCode: 409 });
    expect(
      studioDomainHttpError(
        new StudioResourceHistoryError(
          "studio_history_revision_not_reachable",
          "unsafe"
        )
      )
    ).toMatchObject({ statusCode: 404 });
    expect(
      studioDomainHttpError(
        new StudioResourceHistoryError(
          "studio_history_source_too_large",
          "unsafe"
        )
      )
    ).toMatchObject({ statusCode: 413 });
  });
});
