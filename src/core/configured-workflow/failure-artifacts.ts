import type { ArtifactStore } from "../artifact-store.js";
import { errorArtifact } from "../configured-workflow-errors.js";
import type {
  FailureArtifactWriter,
  FailureArtifactWriterDependencies,
  FailureArtifactWriteOptions,
  FailureArtifactWriteResult
} from "./contracts.js";
import { artifactRootForWorkflow } from "./bootstrap.js";

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

export function createFailureArtifactWriter({
  Store,
  configs,
  makeRunIdentity
}: FailureArtifactWriterDependencies): FailureArtifactWriter {
  return {
    async writeFailure({
      artifactStore,
      run,
      invocation,
      workflowId,
      runtimeRunId,
      attempt,
      date,
      nonce,
      error
    }: FailureArtifactWriteOptions): Promise<FailureArtifactWriteResult> {
      const activeWorkflowId = workflowId ?? run?.workflow_id ?? "_failed";
      const activeRun =
        run ??
        makeRunIdentity(invocation, {
          workflowId: activeWorkflowId,
          attempt,
          date,
          runtimeRunId,
          nonce
        });
      const activeArtifactStore =
        artifactStore ??
        new Store(
          artifactRootForWorkflow(
            configs.app.artifacts.root,
            activeWorkflowId
          ),
          activeRun.run_id
        );

      if (artifactStore === undefined || run === undefined) {
        await activeArtifactStore.initializeRunDirectory();
        await activeArtifactStore.writeJson("invocation.json", invocation);
        await activeArtifactStore.writeJson("run.json", activeRun);
      }

      const artifact = errorArtifact(activeRun.run_id, error);
      const artifactWriteError = await writeJsonBestEffort(
        activeArtifactStore,
        "error.json",
        artifact
      );

      return {
        ...(runtimeRunId === undefined ? {} : { runtimeRunId }),
        artifactStore: activeArtifactStore,
        run: activeRun,
        workflowId: activeWorkflowId,
        error: artifact,
        ...(artifactWriteError === undefined ? {} : { artifactWriteError })
      };
    }
  };
}
