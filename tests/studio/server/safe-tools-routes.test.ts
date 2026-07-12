import Fastify from "fastify";
import type { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { StudioLocalPrincipal } from "../../../src/studio/contracts/control-api.js";
import { STUDIO_EXPRESSION_FIXTURE_LIMITS } from "../../../src/studio/contracts/expression-evaluation.js";
import { registerStudioExpressionRoutes } from "../../../src/studio/server/routes/expressions.js";
import { registerStudioSchemaRoutes } from "../../../src/studio/server/routes/schemas.js";

const principal: StudioLocalPrincipal = {
  id: "local-user",
  authentication: "local-session"
};

function parseRequest<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown
): T {
  return schema.parse(value);
}

describe("Studio safe tool routes", () => {
  it("registers expression evaluation with principal and request cancellation", async () => {
    const evaluateExpression = vi.fn(async () => ({
      status: "evaluated" as const,
      result: { kind: "json" as const, value: 42 },
      diagnostics: [] as []
    }));
    const server = Fastify({ logger: false });
    await registerStudioExpressionRoutes(server, {
      apiPrefix: "/api/studio/v1",
      control: { evaluateExpression },
      principalFor: () => principal,
      parseRequest
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/expressions/evaluate",
      payload: {
        expression: "$.left + $.right",
        fixture: { left: 20, right: 22 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "evaluated",
      result: { kind: "json", value: 42 },
      diagnostics: []
    });
    expect(evaluateExpression).toHaveBeenCalledWith(
      principal,
      {
        expression: "$.left + $.right",
        fixture: { left: 20, right: 22 }
      },
      expect.any(AbortSignal)
    );
    await server.close();
  });

  it("rejects oversized expression fixtures before invoking the control", async () => {
    const evaluateExpression = vi.fn();
    const server = Fastify({ logger: false });
    server.setErrorHandler((_error, _request, reply) => {
      void reply.code(400).send({ error: "invalid request" });
    });
    await registerStudioExpressionRoutes(server, {
      apiPrefix: "/api/studio/v1",
      control: { evaluateExpression },
      principalFor: () => principal,
      parseRequest
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/expressions/evaluate",
      payload: {
        expression: "true",
        fixture: {
          value: "x".repeat(STUDIO_EXPRESSION_FIXTURE_LIMITS.maxBytes + 1)
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(evaluateExpression).not.toHaveBeenCalled();
    await server.close();
  });

  it("registers bounded schema instance validation", async () => {
    const validateSchemaInstance = vi.fn(async () => ({
      status: "invalid" as const,
      diagnostics: [
        {
          severity: "error" as const,
          code: "instance_schema_mismatch" as const,
          message: "The instance does not satisfy this JSON Schema constraint",
          keyword: "type",
          instance_path: "$",
          schema_path: "#/type"
        }
      ]
    }));
    const server = Fastify({ logger: false });
    await registerStudioSchemaRoutes(server, {
      apiPrefix: "/api/studio/v1",
      control: { validateSchemaInstance },
      principalFor: () => principal,
      parseRequest
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/schemas/validate-instance",
      payload: { schema: { type: "string" }, instance: 42 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "invalid",
      diagnostics: [{ keyword: "type", instance_path: "$" }]
    });
    expect(validateSchemaInstance).toHaveBeenCalledWith(
      principal,
      {
        schema: { type: "string" },
        instance: 42
      },
      expect.any(AbortSignal)
    );
    await server.close();
  });

  it("rejects malformed schema requests before invoking the control", async () => {
    const validateSchemaInstance = vi.fn();
    const server = Fastify({ logger: false });
    server.setErrorHandler((_error, _request, reply) => {
      void reply.code(400).send({ error: "invalid request" });
    });
    await registerStudioSchemaRoutes(server, {
      apiPrefix: "/api/studio/v1",
      control: { validateSchemaInstance },
      principalFor: () => principal,
      parseRequest
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/studio/v1/schemas/validate-instance",
      payload: { schema: [], instance: null }
    });

    expect(response.statusCode).toBe(400);
    expect(validateSchemaInstance).not.toHaveBeenCalled();
    await server.close();
  });
});
