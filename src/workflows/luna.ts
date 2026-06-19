import { readFile } from "node:fs/promises";
import { createAgent, type FlueContext } from "@flue/runtime";
import type { GenericSchema } from "valibot";
import {
  AcceptanceDecisionResult,
  CodeReviewFindingsResult,
  ReviewPlanResult
} from "../core/flue-schemas.js";
import {
  runConfiguredWorkflow,
  type ConfiguredWorkflowResult,
  type RunAgentStepOptions
} from "../core/configured-workflow-runner.js";
import type { Invocation } from "../core/types.js";

type RunWithFlueOptions = {
  defaultWorkflowId?: string;
};

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function promptBody(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function resultSchema(outputSchema: string): GenericSchema {
  if (outputSchema === "review_plan") {
    return ReviewPlanResult;
  }

  if (outputSchema === "code_review_findings") {
    return CodeReviewFindingsResult;
  }

  if (outputSchema === "acceptance_decision") {
    return AcceptanceDecisionResult;
  }

  throw codedError(
    `No Flue result schema is configured for ${outputSchema}`,
    "agent_output_schema_missing"
  );
}

function fakeAgentOutput(agentId: string): unknown {
  if (agentId === "review-planner") {
    return {
      summary: "Deterministic test review plan.",
      focus_areas: ["changed files"],
      files_to_review: []
    };
  }

  if (agentId === "code-reviewer") {
    return {
      findings: [],
      summary: "No deterministic findings."
    };
  }

  if (agentId === "acceptance-reviewer") {
    return {
      decision: "approve",
      summary: "Deterministic fake review passed.",
      blocking_findings: []
    };
  }

  throw codedError(`No fake output configured for ${agentId}`, "fake_agent_missing");
}

async function runFlueAgentStep(
  ctx: FlueContext<Invocation>,
  options: RunAgentStepOptions
): Promise<unknown> {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.LUNA_FAKE_REVIEW_NODES === "1"
  ) {
    return fakeAgentOutput(options.agent.id);
  }

  const agent = createAgent(async () => ({
    description: options.agent.description,
    instructions: await readFile(options.agent.instructionsPath, "utf8"),
    ...options.model
  }));
  const harness = await ctx.init(agent, { name: options.agent.id });
  const session = await harness.session();
  const response = await session.prompt(
    [
      options.agent.description,
      "Use only the provided workflow input and return structured output matching the configured schema.",
      promptBody(options.input)
    ].join("\n\n"),
    {
      result: resultSchema(options.node.output_schema),
      ...options.model
    }
  );

  return response.data;
}

export async function runWithFlue(
  ctx: FlueContext<Invocation>,
  options: RunWithFlueOptions = {}
): Promise<ConfiguredWorkflowResult> {
  return await runConfiguredWorkflow({
    invocation: ctx.payload,
    configRoot: process.env.LUNA_CONFIG_ROOT ?? "config",
    workflowsRoot: "workflows",
    agentsRoot: "agents",
    ...(options.defaultWorkflowId === undefined
      ? {}
      : { defaultWorkflowId: options.defaultWorkflowId }),
    dependencies: {
      runAgentStep: async (agentStepOptions) =>
        await runFlueAgentStep(ctx, agentStepOptions)
    }
  });
}

export async function run(
  ctx: FlueContext<Invocation>
): Promise<ConfiguredWorkflowResult> {
  return await runWithFlue(ctx);
}
