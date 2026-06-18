import path from "node:path";
import type { FlueContext } from "@flue/runtime";
import acceptanceReviewer from "../agents/acceptance-reviewer.js";
import codeReviewer from "../agents/code-reviewer.js";
import reviewPlanner from "../agents/review-planner.js";
import {
  executeCodeReview,
  type CodeReviewOrchestratorDependencies,
  type CodeReviewResult
} from "../core/code-review-orchestrator.js";
import { loadYamlFile, resolveConfigRoot } from "../core/config-loader.js";
import { collectRepoContext } from "../core/repo-context-collector.js";
import { runStructuredNode } from "../core/structured-node.js";
import {
  AcceptanceDecisionResult,
  CodeReviewFindingsResult,
  ReviewPlanResult
} from "../core/flue-schemas.js";
import { resolveModelProfiles, toFlueModelOptions } from "../core/model-config.js";
import {
  AppConfigSchema,
  ModelsConfigSchema,
  RepositoriesConfigSchema,
  RoutingConfigSchema,
  type AcceptanceDecision,
  type AppConfig,
  type CodeReviewFindings,
  type Invocation,
  type RepoContext,
  type RepositoriesConfig,
  type ReviewPlan,
  type RoutingConfig
} from "../core/types.js";

type LoadedConfigs = {
  app: AppConfig;
  repositories: RepositoriesConfig;
  routing: RoutingConfig;
};

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function loadConfigs(configRoot: string): Promise<LoadedConfigs> {
  const [app, repositories, routing] = await Promise.all([
    loadYamlFile(path.join(configRoot, "app.yaml"), AppConfigSchema),
    loadYamlFile(
      path.join(configRoot, "repositories.yaml"),
      RepositoriesConfigSchema
    ),
    loadYamlFile(path.join(configRoot, "routing.yaml"), RoutingConfigSchema)
  ]);

  return { app, repositories, routing };
}

function promptBody(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function assertRepoContext(
  repoContext: RepoContext | undefined
): RepoContext {
  if (repoContext === undefined) {
    throw codedError(
      "Repository context is not available to the review workflow node",
      "workflow_context_missing"
    );
  }

  return repoContext;
}

function assertReviewPlan(reviewPlan: ReviewPlan | undefined): ReviewPlan {
  if (reviewPlan === undefined) {
    throw codedError(
      "Review plan is not available to the code reviewer node",
      "workflow_context_missing"
    );
  }

  return reviewPlan;
}

function assertFindings(
  findings: CodeReviewFindings | undefined
): CodeReviewFindings {
  if (findings === undefined) {
    throw codedError(
      "Code review findings are not available to the acceptance reviewer node",
      "workflow_context_missing"
    );
  }

  return findings;
}

function fakeNodes() {
  const reviewPlan: ReviewPlan = {
    summary: "Deterministic test review plan.",
    focus_areas: ["changed files"],
    files_to_review: []
  };
  const findings: CodeReviewFindings = {
    findings: [],
    summary: "No deterministic findings."
  };
  const acceptance: AcceptanceDecision = {
    decision: "approve",
    summary: "Deterministic fake review passed.",
    blocking_findings: []
  };

  return {
    reviewPlanner: { execute: async () => reviewPlan },
    codeReviewer: { execute: async () => findings },
    acceptanceReviewer: { execute: async () => acceptance }
  };
}

export async function run(
  ctx: FlueContext<Invocation>
): Promise<CodeReviewResult> {
  const configRoot = resolveConfigRoot(process.env);
  const configs = await loadConfigs(configRoot);
  const modelsConfig = await loadYamlFile(
    path.join(configRoot, "models.yaml"),
    ModelsConfigSchema
  );
  const modelProfiles = resolveModelProfiles(modelsConfig, process.env);
  const plannerModel = toFlueModelOptions(modelProfiles.planner);
  const reviewerModel = toFlueModelOptions(modelProfiles.reviewer);
  const acceptanceModel = toFlueModelOptions(modelProfiles.acceptance);

  let repoContext: RepoContext | undefined;
  let reviewPlan: ReviewPlan | undefined;
  let codeReviewFindings: CodeReviewFindings | undefined;

  const dependencies: CodeReviewOrchestratorDependencies = {
    collectRepoContext: async (options) => {
      repoContext = await collectRepoContext(options);
      return repoContext;
    },
    runStructuredNode: async (options) => {
      const result = await runStructuredNode(options);

      if (options.nodeName === "review-planner") {
        reviewPlan = result as ReviewPlan;
      } else if (options.nodeName === "code-reviewer") {
        codeReviewFindings = result as CodeReviewFindings;
      }

      return result;
    }
  };

  const nodes =
    process.env.NODE_ENV === "test" && process.env.LUNA_FAKE_REVIEW_NODES === "1"
      ? fakeNodes()
      : {
          reviewPlanner: {
            execute: async () => {
              const harness = await ctx.init(reviewPlanner);
              const session = await harness.session();
              const response = await session.prompt(
                [
                  "Create a focused pull request review plan using only this invocation and repository context.",
                  promptBody({
                    invocation: ctx.payload,
                    repoContext: assertRepoContext(repoContext)
                  })
                ].join("\n\n"),
                { result: ReviewPlanResult, ...plannerModel }
              );

              return response.data;
            }
          },
          codeReviewer: {
            execute: async () => {
              const harness = await ctx.init(codeReviewer);
              const session = await harness.session();
              const response = await session.prompt(
                [
                  "Review the pull request for concrete defects using only this invocation, repository context, and review plan.",
                  promptBody({
                    invocation: ctx.payload,
                    repoContext: assertRepoContext(repoContext),
                    reviewPlan: assertReviewPlan(reviewPlan)
                  })
                ].join("\n\n"),
                { result: CodeReviewFindingsResult, ...reviewerModel }
              );

              return response.data;
            }
          },
          acceptanceReviewer: {
            execute: async () => {
              const harness = await ctx.init(acceptanceReviewer);
              const session = await harness.session();
              const response = await session.prompt(
                [
                  "Decide whether the review should approve, comment, or request changes using only these workflow inputs.",
                  promptBody({
                    invocation: ctx.payload,
                    repoContext: assertRepoContext(repoContext),
                    reviewPlan: assertReviewPlan(reviewPlan),
                    findings: assertFindings(codeReviewFindings)
                  })
                ].join("\n\n"),
                { result: AcceptanceDecisionResult, ...acceptanceModel }
              );

              return response.data;
            }
          }
        };

  return await executeCodeReview({
    invocation: ctx.payload,
    configs,
    nodes,
    dependencies
  });
}
