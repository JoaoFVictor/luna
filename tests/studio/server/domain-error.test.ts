import { describe, expect, it } from "vitest";
import {
  RUN_STORE_ERROR_CODES,
  RunStoreError
} from "../../../src/studio/application/runs/errors.js";
import { studioDomainHttpError } from "../../../src/studio/server/domain-error.js";
import { StudioRunResumeError } from "../../../src/studio/application/runs/resume-errors.js";

describe("Studio domain HTTP errors", () => {
  it("maps every Run Ledger error without publishing its internal message", () => {
    const secret = "sqlite-path-or-secret";

    for (const code of RUN_STORE_ERROR_CODES) {
      const projected = studioDomainHttpError(
        new RunStoreError(code, `unsafe ${secret}`)
      );
      expect(projected, code).toBeDefined();
      expect(projected?.code).toBe(code);
      expect(projected?.message).not.toContain(secret);
      expect(projected?.statusCode).toBeGreaterThanOrEqual(400);
      expect(projected?.statusCode).toBeLessThan(600);
    }
  });

  it("uses stable client semantics for missing, expired, and busy run reads", () => {
    expect(
      studioDomainHttpError(new RunStoreError("run_not_found", "unsafe"))
    ).toMatchObject({ statusCode: 404, code: "run_not_found" });
    expect(
      studioDomainHttpError(new RunStoreError("run_cursor_expired", "unsafe"))
    ).toMatchObject({ statusCode: 410, code: "run_cursor_expired" });
    expect(
      studioDomainHttpError(new RunStoreError("run_store_busy", "unsafe"))
    ).toMatchObject({ statusCode: 503, code: "run_store_busy" });
  });

  it("reports capability catalog drift as a safe conflict instead of storage corruption", () => {
    expect(studioDomainHttpError(new StudioRunResumeError(
      "studio_run_resume_catalog_changed",
      "unsafe implementation detail"
    ))).toEqual({
      statusCode: 409,
      code: "studio_run_resume_catalog_changed",
      message: "The run cannot be resumed because the runtime capability catalog changed"
    });
  });
});
