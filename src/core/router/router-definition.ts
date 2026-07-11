import jsonata from "jsonata";
import { z } from "zod";
import { WORKFLOW_ID_PATTERN } from "./invocation.js";

export const ROUTER_RULE_ID_MAX_LENGTH = 128;
export const ROUTER_RULE_EXPRESSION_MAX_LENGTH = 8 * 1_024;
export const ROUTER_DEFINITION_MAX_RULES = 256;

const RouterRuleIdSchema = z
  .string()
  .min(1)
  .max(ROUTER_RULE_ID_MAX_LENGTH);
const RouterRuleExpressionSchema = z
  .string()
  .min(1)
  .max(ROUTER_RULE_EXPRESSION_MAX_LENGTH);
const WorkflowTargetStringSchema = z
  .string()
  .regex(new RegExp(`^workflow:${WORKFLOW_ID_PATTERN.slice(1, -1)}$`));
const TargetExpressionSchema = z.literal("$.invocation.target");

export const RouterRuleSchema = z
  .object({
    id: RouterRuleIdSchema,
    when: z
      .object({
        expression: RouterRuleExpressionSchema
      })
      .strict(),
    target: z.union([WorkflowTargetStringSchema, TargetExpressionSchema])
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.when.expression.length > ROUTER_RULE_EXPRESSION_MAX_LENGTH) {
      return;
    }

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
    rules: z
      .array(RouterRuleSchema)
      .min(1)
      .max(ROUTER_DEFINITION_MAX_RULES)
  })
  .strict()
  .superRefine((definition, context) => {
    if (definition.rules.length > ROUTER_DEFINITION_MAX_RULES) {
      return;
    }

    const ids = new Set<string>();

    definition.rules.forEach((rule, index) => {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Router rule ids must be unique",
          path: ["rules", index, "id"]
        });
      }

      ids.add(rule.id);
    });
  });

export type RouterDefinition = z.infer<typeof RouterDefinitionSchema>;
