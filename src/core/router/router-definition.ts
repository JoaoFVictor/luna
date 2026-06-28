import jsonata from "jsonata";
import { z } from "zod";
import { WORKFLOW_ID_PATTERN } from "./invocation.js";

const NonEmptyStringSchema = z.string().min(1);
const WorkflowTargetStringSchema = z
  .string()
  .regex(new RegExp(`^workflow:${WORKFLOW_ID_PATTERN.slice(1, -1)}$`));
const TargetExpressionSchema = z.literal("$.invocation.target");

export const RouterRuleSchema = z
  .object({
    id: NonEmptyStringSchema,
    when: z
      .object({
        expression: NonEmptyStringSchema
      })
      .strict(),
    target: z.union([WorkflowTargetStringSchema, TargetExpressionSchema])
  })
  .strict()
  .superRefine((rule, context) => {
    try {
      jsonata(rule.when.expression);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Router rule when.expression must be valid JSONata.",
        path: ["when", "expression"]
      });
    }
  });

export type RouterRule = z.infer<typeof RouterRuleSchema>;

export const RouterDefinitionSchema = z
  .object({
    type: z.literal("router"),
    version: z.literal("2026-06"),
    rules: z.array(RouterRuleSchema).min(1)
  })
  .strict()
  .superRefine((definition, context) => {
    const ids = new Set<string>();

    definition.rules.forEach((rule, index) => {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate router rule id: ${rule.id}`,
          path: ["rules", index, "id"]
        });
      }

      ids.add(rule.id);
    });
  });

export type RouterDefinition = z.infer<typeof RouterDefinitionSchema>;
