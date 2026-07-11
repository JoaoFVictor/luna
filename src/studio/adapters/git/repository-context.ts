import { realpath } from "node:fs/promises";
import { StudioResourceHistoryError } from "../../application/history/errors.js";
import {
  StudioGitRevisionIdSchema,
  type StudioGitRevisionId,
  type StudioHistoryResource
} from "../../contracts/resource-history.js";
import type {
  StudioGitReadRequest,
  StudioGitReadResult
} from "./read-process.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_GIT_METADATA_BYTES = 4 * 1024;

export type StudioGitRepositoryContext = {
  readonly root: string;
  readonly head: StudioGitRevisionId;
};

export type StudioGitCommand = (
  cwd: string,
  request: Omit<StudioGitReadRequest, "cwd" | "timeoutMs">
) => Promise<StudioGitReadResult>;

function unavailable(cause?: unknown): StudioResourceHistoryError {
  return new StudioResourceHistoryError(
    "studio_history_unavailable",
    "Git history requires an attached branch at the Studio project root",
    { cause }
  );
}

function oneLine(output: Uint8Array, label: string): string {
  let value: string;
  try {
    value = UTF8_DECODER.decode(output).trim();
  } catch (cause) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      `${label} is not valid UTF-8`,
      { cause }
    );
  }
  if (value === "" || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      `${label} is invalid`
    );
  }
  return value;
}

export async function loadStudioGitRepositoryContext(
  projectRoot: string,
  command: StudioGitCommand
): Promise<StudioGitRepositoryContext> {
  try {
    const resolvedRoot = await realpath(projectRoot);
    const topLevel = oneLine(
      (
        await command(projectRoot, {
          args: ["rev-parse", "--show-toplevel"],
          maxStdoutBytes: MAX_GIT_METADATA_BYTES
        })
      ).stdout,
      "Git project root"
    );
    if ((await realpath(topLevel)) !== resolvedRoot) {
      throw unavailable();
    }
    const branch = await command(resolvedRoot, {
      args: ["symbolic-ref", "--quiet", "HEAD"],
      maxStdoutBytes: MAX_GIT_METADATA_BYTES,
      acceptedExitCodes: [0, 1]
    });
    if (branch.exitCode !== 0) {
      throw unavailable();
    }
    const branchRef = oneLine(branch.stdout, "Git branch reference");
    if (!branchRef.startsWith("refs/heads/") || branchRef.length > 1024) {
      throw unavailable();
    }
    const rawHead = oneLine(
      (
        await command(resolvedRoot, {
          args: ["rev-parse", "--verify", "HEAD^{commit}"],
          maxStdoutBytes: MAX_GIT_METADATA_BYTES
        })
      ).stdout,
      "Git HEAD"
    );
    const head = StudioGitRevisionIdSchema.safeParse(rawHead);
    if (!head.success) {
      throw unavailable();
    }
    return { root: resolvedRoot, head: head.data };
  } catch (cause) {
    if (
      cause instanceof StudioResourceHistoryError &&
      cause.code === "studio_history_unavailable"
    ) {
      throw cause;
    }
    throw unavailable(cause);
  }
}

export async function assertStudioGitRevisionReachable(
  repository: StudioGitRepositoryContext,
  revisionId: StudioGitRevisionId,
  resource: StudioHistoryResource,
  command: StudioGitCommand
): Promise<void> {
  try {
    const objectType = oneLine(
      (
        await command(repository.root, {
          args: ["cat-file", "-t", revisionId],
          maxStdoutBytes: MAX_GIT_METADATA_BYTES
        })
      ).stdout,
      "Git object type"
    );
    if (objectType !== "commit") {
      throw new Error("Revision is not a commit");
    }
    const ancestry = await command(repository.root, {
      args: ["merge-base", "--is-ancestor", revisionId, repository.head],
      maxStdoutBytes: MAX_GIT_METADATA_BYTES,
      acceptedExitCodes: [0, 1]
    });
    if (ancestry.exitCode !== 0) {
      throw new Error("Revision is not reachable from current branch");
    }
  } catch (cause) {
    throw new StudioResourceHistoryError(
      "studio_history_revision_not_reachable",
      "The selected revision is not reachable from the current branch",
      { cause, details: { resource } }
    );
  }
}
