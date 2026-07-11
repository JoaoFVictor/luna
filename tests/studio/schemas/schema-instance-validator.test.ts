import { describe, expect, it } from "vitest";
import {
  createStudioSchemaValidationService,
  StudioSchemaRequestError
} from "../../../src/studio/application/schemas/schema-instance-validator.js";
import {
  STUDIO_SCHEMA_DIAGNOSTICS_MAX,
  STUDIO_SCHEMA_DOCUMENT_LIMITS,
  StudioSchemaValidationRequestSchema,
  StudioSchemaValidationSchema
} from "../../../src/studio/contracts/schema-validation.js";

describe("Studio JSON Schema instance validation", () => {
  const service = createStudioSchemaValidationService();
  const openSignal = new AbortController().signal;

  it("validates with the canonical Luna schema matcher", async () => {
    await expect(
      service.validate({
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 3 }
          }
        },
        instance: { name: "Luna" }
      }, openSignal)
    ).resolves.toEqual({ status: "valid", diagnostics: [] });
  });

  it("returns structured instance and schema pointers without echoing values", async () => {
    const result = await service.validate({
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 3 }
        }
      },
      instance: { name: "secret", unexpected: "do-not-echo" }
    }, openSignal);

    expect(result).toMatchObject({
      status: "invalid",
      diagnostics: [
        {
          severity: "error",
          code: "instance_schema_mismatch",
          keyword: "additionalProperties",
          instance_path: "$/unexpected",
          schema_path: "#/additionalProperties"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("do-not-echo");
    expect(() => StudioSchemaValidationSchema.parse(result)).not.toThrow();
  });

  it("identifies nested field constraints", async () => {
    const result = await service.validate({
      schema: {
        type: "object",
        properties: {
          profile: {
            type: "object",
            properties: {
              display_name: { type: "string", minLength: 4 }
            }
          }
        }
      },
      instance: { profile: { display_name: "x" } }
    }, openSignal);

    expect(result).toMatchObject({
      status: "invalid",
      diagnostics: [
        {
          keyword: "minLength",
          instance_path: "$/profile/display_name",
          schema_path: "#/properties/profile/properties/display_name/minLength"
        }
      ]
    });
  });

  it("reports malformed schemas with generic diagnostics", async () => {
    const result = await service.validate({
      schema: {
        type: "object",
        pattern: "(?<internal-super-secret"
      },
      instance: {}
    }, openSignal);

    expect(result).toMatchObject({
      status: "schema_invalid",
      diagnostics: [
        {
          code: "schema_invalid",
          keyword: "pattern",
          schema_path: "#/pattern"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("internal-super-secret");
  });

  it("marks unenforced keywords instead of pretending the runtime enforced them", async () => {
    const result = await service.validate({
      schema: {
        type: "object",
        properties: { email: { type: "string", format: "email" } },
        additionalProperties: { type: "string" }
      },
      instance: { email: "not-an-email", count: 3 }
    }, openSignal);

    expect(result.status).toBe("valid");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          code: "schema_keyword_unsupported",
          keyword: "format",
          schema_path: "#/properties/email/format"
        }),
        expect.objectContaining({
          severity: "warning",
          code: "schema_keyword_unsupported",
          keyword: "additionalProperties",
          schema_path: "#/additionalProperties"
        })
      ])
    );
  });

  it("caps diagnostics and declares truncation", async () => {
    const required = Array.from({ length: 200 }, (_, index) => `field_${index}`);
    const result = await service.validate({
      schema: { type: "object", required },
      instance: {}
    }, openSignal);

    expect(result.status).toBe("invalid");
    expect(result.diagnostics).toHaveLength(STUDIO_SCHEMA_DIAGNOSTICS_MAX);
    expect(result.diagnostics.at(-1)).toMatchObject({
      severity: "warning",
      code: "diagnostics_truncated"
    });
    expect(result.diagnostics[0]?.code).toBe("instance_schema_mismatch");
  });

  it("terminates potentially pathological pattern evaluation at the server timeout", async () => {
    const guardedService = createStudioSchemaValidationService({
      timeoutMs: 30
    });
    const result = await guardedService.validate(
      {
        schema: { type: "string", pattern: "^(a+)+$" },
        instance: `${"a".repeat(100)}!`
      },
      openSignal
    );

    expect(result).toMatchObject({
      status: "error",
      diagnostics: [{ code: "schema_validation_timeout" }]
    });
  });

  it("cancels isolated schema validation with the caller", async () => {
    const guardedService = createStudioSchemaValidationService({
      timeoutMs: 1_000
    });
    const caller = new AbortController();
    const outcome = guardedService.validate(
      {
        schema: { type: "string", pattern: "^(a+)+$" },
        instance: `${"a".repeat(100)}!`
      },
      caller.signal
    );
    caller.abort();

    await expect(outcome).resolves.toMatchObject({
      status: "error",
      diagnostics: [{ code: "schema_validation_cancelled" }]
    });
  });

  it("rejects oversized schema documents at the request boundary", async () => {
    const request = {
      schema: {
        description: "x".repeat(STUDIO_SCHEMA_DOCUMENT_LIMITS.maxBytes + 1)
      },
      instance: null
    };

    expect(StudioSchemaValidationRequestSchema.safeParse(request).success).toBe(
      false
    );
    await expect(service.validate(request, openSignal)).rejects.toBeInstanceOf(
      StudioSchemaRequestError
    );
  });
});
