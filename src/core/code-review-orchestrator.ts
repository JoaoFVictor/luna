import { ArtifactStore } from "./artifact-store.js";
import {
  buildFinalReportJson,
  buildFinalReportMarkdown,
  type FinalReportJson
} from "./report-builder.js";
import { cleanup, prepare } from "./git-worktree-manager.js";
import { collectRepoContext } from "./repo-context-collector.js";
import { runPreflight, type PreflightResult } from "./preflight.js";
import { resolveRepository } from "./workspace-resolver.js";
import { routeInvocation } from "./router.js";
import { createRunIdentity } from "./run-identity.js";
import { runStructuredNode } from "./structured-node.js";
import { validateFindingEvidence } from "./evidence-validator.js";
import {
  AcceptanceDecisionSchema,
  CodeReviewFindingsSchema,
  ReviewPlanSchema,
  type AcceptanceDecision,
  type AppConfig,
  type CodeReviewFindings,
  type ErrorArtifact,
  type Invocation,
  type RepoContext,
  type RepositoriesConfig,
  type RepositoryConfig,
  type ReviewPlan,
  type RouteTarget,
  type RoutingConfig,
  type RunIdentity,
  type WorkspaceRecord
} from "./types.js";

type NodeExecutor = {
  execute: () => Promise<unknown>;
};

export type CodeReviewOrchestratorConfigs = {
  app: AppConfig;
  repositories: RepositoriesConfig;
  routing: RoutingConfig;
};

type StructuredNodeRunner = typeof runStructuredNode;

export type CodeReviewOrchestratorDependencies = {
  createRunIdentity?: (
    invocation: Invocation,
    attempt: number,
    date?: Date
  ) => RunIdentity;
  routeInvocation?: typeof routeInvocation;
  resolveRepository?: typeof resolveRepository;
  runPreflight?: typeof runPreflight;
  prepareWorktree?: typeof prepare;
  cleanupWorktree?: typeof cleanup;
  collectRepoContext?: typeof collectRepoContext;
  runStructuredNode?: StructuredNodeRunner;
  validateFindingEvidence?: typeof validateFindingEvidence;
  buildFinalReportMarkdown?: typeof buildFinalReportMarkdown;
  buildFinalReportJson?: typeof buildFinalReportJson;
  ArtifactStore?: typeof ArtifactStore;
  now?: () => Date;
};

export type ExecuteCodeReviewOptions = {
  invocation: Invocation;
  configs: CodeReviewOrchestratorConfigs;
  nodes: {
    reviewPlanner: NodeExecutor;
    codeReviewer: NodeExecutor;
    acceptanceReviewer: NodeExecutor;
  };
  dependencies?: CodeReviewOrchestratorDependencies;
  attempt?: number;
  throwOnError?: boolean;
};

export type CodeReviewSuccessResult = {
  status: "success";
  run: RunIdentity;
  report: FinalReportJson;
  workspace?: WorkspaceRecord;
};

export type CodeReviewFailureResult = {
  status: "failed";
  run: RunIdentity;
  error: ErrorArtifact;
  workspace?: WorkspaceRecord;
};

export type CodeReviewResult =
  | CodeReviewSuccessResult
  | CodeReviewFailureResult;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code !== "" ? code : "unknown_error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }

  return String(error);
}

function errorArtifact(runId: string, error: unknown): ErrorArtifact {
  return {
    run_id: runId,
    code: errorCode(error),
    message: errorMessage(error)
  };
}

function codedError(
  message: string,
  code: string,
  cause?: unknown
): Error & { code: string } {
  const error = new Error(message, { cause }) as Error & { code: string };
  error.code = code;
  return error;
}

function assertCodeReviewWorkflow(target: RouteTarget): void {
  if (target.type !== "workflow" || target.id !== "code-review") {
    throw codedError(
      `Unsupported workflow target: ${target.type}/${target.id}`,
      "wrong_workflow_target"
    );
  }
}

async function writeJsonBestEffort(
  artifactStore: ArtifactStore,
  name: string,
  value: unknown
): Promise<unknown> {
  try {
    await artifactStore.writeJson(name, value);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function finalizeFailureWorkspace({
  artifactStore,
  workspaceRecord,
  persistedWorkspaceRecord,
  repository,
  workspaceConfig,
  cleanupWorktree
}: {
  artifactStore: ArtifactStore;
  workspaceRecord?: WorkspaceRecord;
  persistedWorkspaceRecord?: WorkspaceRecord;
  repository?: RepositoryConfig;
  workspaceConfig: AppConfig["workspace"];
  cleanupWorktree: typeof cleanup;
}): Promise<WorkspaceRecord | undefined> {
  if (workspaceRecord === undefined) {
    return undefined;
  }

  let finalWorkspace = workspaceRecord;

  if (
    workspaceRecord.reason === "success_cleanup" ||
    workspaceRecord.reason === "success_cleanup_failed" ||
    workspaceRecord.reason === "success_preserved" ||
    workspaceRecord.reason === "failure_cleanup_failed" ||
    workspaceRecord.reason === "failure_preserved"
  ) {
    finalWorkspace = workspaceRecord;
  } else if (workspaceConfig.preserve_on_failure) {
    finalWorkspace = {
      ...workspaceRecord,
      preserved: true,
      reason: "failure_preserved"
    };
  } else if (repository !== undefined) {
    try {
      finalWorkspace = await cleanupWorktree({
        repositoryPath: repository.path,
        workspaceRoot: workspaceConfig.root,
        workspaceRecord,
        persistedWorkspaceRecord
      });
    } catch {
      finalWorkspace = {
        ...workspaceRecord,
        preserved: true,
        reason: "failure_cleanup_failed"
      };
    }
  }

  await artifactStore.writeJson("workspace.json", finalWorkspace);
  return finalWorkspace;
}

export async function executeCodeReview({
  invocation,
  configs,
  nodes,
  dependencies = {},
  attempt = 1,
  throwOnError = true
}: ExecuteCodeReviewOptions): Promise<CodeReviewResult> {
  const makeRunIdentity = dependencies.createRunIdentity ?? createRunIdentity;
  const route = dependencies.routeInvocation ?? routeInvocation;
  const resolveRepo = dependencies.resolveRepository ?? resolveRepository;
  const preflight = dependencies.runPreflight ?? runPreflight;
  const prepareWorktree = dependencies.prepareWorktree ?? prepare;
  const cleanupWorktree = dependencies.cleanupWorktree ?? cleanup;
  const contextCollector = dependencies.collectRepoContext ?? collectRepoContext;
  const structuredNode = dependencies.runStructuredNode ?? runStructuredNode;
  const validateEvidence =
    dependencies.validateFindingEvidence ?? validateFindingEvidence;
  const markdownReport =
    dependencies.buildFinalReportMarkdown ?? buildFinalReportMarkdown;
  const jsonReport = dependencies.buildFinalReportJson ?? buildFinalReportJson;
  const Store = dependencies.ArtifactStore ?? ArtifactStore;

  const run = makeRunIdentity(invocation, attempt, dependencies.now?.());
  const artifactStore = new Store(configs.app.artifacts.root, run.run_id);
  let repository: RepositoryConfig | undefined;
  let workspaceRecord: WorkspaceRecord | undefined;
  let persistedWorkspaceRecord: WorkspaceRecord | undefined;

  await artifactStore.writeJson("invocation.json", invocation);
  await artifactStore.writeJson("run.json", run);

  try {
    const routeTarget = route(invocation, configs.routing);
    assertCodeReviewWorkflow(routeTarget);
    repository = resolveRepo(invocation, configs.repositories.repositories);

    const preflightResult = (await preflight({
      invocation,
      repository
    })) as PreflightResult;
    await artifactStore.writeJson("preflight.json", preflightResult);

    workspaceRecord = await prepareWorktree({
      invocation,
      repository,
      workspaceRoot: configs.app.workspace.root,
      runId: run.run_id
    });
    await artifactStore.writeJson("workspace.json", workspaceRecord);
    persistedWorkspaceRecord = workspaceRecord;

    const workspaceRepository = {
      ...repository,
      path: workspaceRecord.path
    };
    const repoContext = (await contextCollector({
      invocation,
      repository: workspaceRepository
    })) as RepoContext;
    await artifactStore.writeJson("repo-context.json", repoContext);

    const reviewPlan = (await structuredNode({
      nodeName: "review-planner",
      schema: ReviewPlanSchema,
      artifactStore,
      execute: nodes.reviewPlanner.execute
    })) as ReviewPlan;
    await artifactStore.writeJson("review-plan.json", reviewPlan);

    const rawFindings = (await structuredNode({
      nodeName: "code-reviewer",
      schema: CodeReviewFindingsSchema,
      artifactStore,
      execute: nodes.codeReviewer.execute
    })) as CodeReviewFindings;
    const codeReviewFindings: CodeReviewFindings = {
      ...rawFindings,
      findings: validateEvidence(repoContext, rawFindings.findings)
    };
    await artifactStore.writeJson(
      "code-review-findings.json",
      codeReviewFindings
    );

    const acceptance = (await structuredNode({
      nodeName: "acceptance-reviewer",
      schema: AcceptanceDecisionSchema,
      artifactStore,
      execute: nodes.acceptanceReviewer.execute
    })) as AcceptanceDecision;
    await artifactStore.writeJson("acceptance-review.json", acceptance);

    let finalWorkspace = workspaceRecord;
    if (!configs.app.workspace.preserve_on_success) {
      try {
        finalWorkspace = await cleanupWorktree({
          repositoryPath: repository.path,
          workspaceRoot: configs.app.workspace.root,
          workspaceRecord,
          persistedWorkspaceRecord
        });
      } catch (cause) {
        workspaceRecord = {
          ...workspaceRecord,
          preserved: true,
          reason: "success_cleanup_failed"
        };
        throw codedError(
          "Successful review workspace cleanup failed",
          "success_cleanup_failed",
          cause
        );
      }
    } else {
      finalWorkspace = {
        ...workspaceRecord,
        preserved: true,
        reason: "success_preserved"
      };
    }

    await artifactStore.writeJson("workspace.json", finalWorkspace);
    workspaceRecord = finalWorkspace;

    const markdown = markdownReport({
      invocation,
      findings: codeReviewFindings.findings,
      acceptance
    });
    const reportPath = await artifactStore.writeMarkdown(
      "final-report.md",
      markdown
    );
    const report = jsonReport({
      acceptance,
      findings: codeReviewFindings.findings,
      reportPath,
      workspace: finalWorkspace
    });
    await artifactStore.writeJson("final-report.json", report);

    return {
      status: "success",
      run,
      report,
      workspace: finalWorkspace
    };
  } catch (error) {
    const artifact = errorArtifact(run.run_id, error);
    const artifactWriteError = await writeJsonBestEffort(
      artifactStore,
      "error.json",
      artifact
    );
    let finalWorkspace: WorkspaceRecord | undefined;
    const workspaceWriteError = await (async () => {
      try {
        finalWorkspace = await finalizeFailureWorkspace({
          artifactStore,
          workspaceRecord,
          persistedWorkspaceRecord,
          repository,
          workspaceConfig: configs.app.workspace,
          cleanupWorktree
        });
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();

    if (throwOnError) {
      throw error;
    }

    if (artifactWriteError !== undefined || workspaceWriteError !== undefined) {
      artifact.details = {
        ...(artifactWriteError === undefined
          ? {}
          : { error_artifact_write_failed: errorMessage(artifactWriteError) }),
        ...(workspaceWriteError === undefined
          ? {}
          : { workspace_artifact_write_failed: errorMessage(workspaceWriteError) })
      };
    }

    return {
      status: "failed",
      run,
      error: artifact,
      workspace: finalWorkspace
    };
  }
}
