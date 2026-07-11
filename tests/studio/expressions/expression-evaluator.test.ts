import { describe, expect, it, vi } from "vitest";
import {
  createStudioExpressionService,
  StudioExpressionRequestError
} from "../../../src/studio/application/expressions/expression-evaluator.js";
import type { StudioExpressionExecutor } from "../../../src/studio/application/expressions/isolated-jsonata-executor.js";
import {
  STUDIO_EXPRESSION_FIXTURE_LIMITS,
  STUDIO_EXPRESSION_RESULT_LIMITS,
  StudioExpressionEvaluationSchema
} from "../../../src/studio/contracts/expression-evaluation.js";

const openSignal = new AbortController().signal;

describe("Studio expression evaluation", () => {
  it("evaluates JSONata against only the bounded fixture", async () => {
    const service = createStudioExpressionService({ timeoutMs: 1_000 });

    await expect(
      service.evaluate(
        {
          expression: "$.left + $.right",
          fixture: { left: 20, right: 22 }
        },
        openSignal
      )
    ).resolves.toEqual({
      status: "evaluated",
      result: { kind: "json", value: 42 },
      diagnostics: []
    });
  });

  it("does not expose process or environment globals to expressions", async () => {
    const service = createStudioExpressionService({ timeoutMs: 1_000 });

    await expect(
      service.evaluate(
        { expression: "$process", fixture: {} },
        openSignal
      )
    ).resolves.toEqual({
      status: "evaluated",
      result: { kind: "undefined" },
      diagnostics: []
    });
  });

  it("returns public generic diagnostics for syntax and evaluation failures", async () => {
    const service = createStudioExpressionService({ timeoutMs: 1_000 });
    const invalid = await service.evaluate(
      { expression: "($super_secret", fixture: {} },
      openSignal
    );
    const failed = await service.evaluate(
      { expression: '$error("runtime-super-secret")', fixture: {} },
      openSignal
    );

    expect(invalid).toMatchObject({
      status: "error",
      diagnostics: [{ code: "expression_invalid" }]
    });
    expect(failed).toMatchObject({
      status: "error",
      diagnostics: [{ code: "expression_evaluation_failed" }]
    });
    expect(JSON.stringify([invalid, failed])).not.toContain("super-secret");
    expect(() => StudioExpressionEvaluationSchema.parse(invalid)).not.toThrow();
  });

  it("rejects non-JSON results inside the isolated worker", async () => {
    const service = createStudioExpressionService({ timeoutMs: 1_000 });

    await expect(
      service.evaluate(
        { expression: "function($value) { $value }", fixture: {} },
        openSignal
      )
    ).resolves.toMatchObject({
      status: "error",
      diagnostics: [{ code: "expression_result_invalid" }]
    });
  });

  it("terminates a non-cooperative expression at the server timeout", async () => {
    const service = createStudioExpressionService({ timeoutMs: 30 });

    await expect(
      service.evaluate(
        {
          expression: "($loop := function(){ $loop() }; $loop())",
          fixture: {}
        },
        openSignal
      )
    ).resolves.toMatchObject({
      status: "error",
      diagnostics: [{ code: "expression_timeout" }]
    });
  });

  it("terminates isolated evaluation when the caller cancels", async () => {
    const service = createStudioExpressionService({ timeoutMs: 1_000 });
    const caller = new AbortController();
    const outcome = service.evaluate(
      {
        expression: "($loop := function(){ $loop() }; $loop())",
        fixture: {}
      },
      caller.signal
    );
    caller.abort();

    await expect(outcome).resolves.toMatchObject({
      status: "error",
      diagnostics: [{ code: "expression_cancelled" }]
    });
  });

  it("enforces fixture bounds before invoking the executor", async () => {
    const evaluate = vi.fn<StudioExpressionExecutor["evaluate"]>();
    const service = createStudioExpressionService({
      executor: { evaluate },
      timeoutMs: 1_000
    });

    await expect(
      service.evaluate(
        {
          expression: "true",
          fixture: {
            oversized: "x".repeat(
              STUDIO_EXPRESSION_FIXTURE_LIMITS.maxBytes + 1
            )
          }
        },
        openSignal
      )
    ).rejects.toBeInstanceOf(StudioExpressionRequestError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("revalidates executor output and hides executor failures", async () => {
    const oversizedExecutor: StudioExpressionExecutor = {
      async evaluate() {
        return {
          kind: "value",
          value: "x".repeat(STUDIO_EXPRESSION_RESULT_LIMITS.maxBytes + 1)
        };
      }
    };
    const throwingExecutor: StudioExpressionExecutor = {
      async evaluate() {
        throw new Error("internal-super-secret");
      }
    };
    const oversized = await createStudioExpressionService({
      executor: oversizedExecutor
    }).evaluate({ expression: "true", fixture: {} }, openSignal);
    const failed = await createStudioExpressionService({
      executor: throwingExecutor
    }).evaluate({ expression: "true", fixture: {} }, openSignal);

    expect(oversized).toMatchObject({
      diagnostics: [{ code: "expression_result_invalid" }]
    });
    expect(failed).toMatchObject({
      diagnostics: [{ code: "expression_evaluation_failed" }]
    });
    expect(JSON.stringify([oversized, failed])).not.toContain("super-secret");
  });
});
