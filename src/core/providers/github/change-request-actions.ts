import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ChangeRequestArtifact,
  ChangeRequestProvider,
  OpenChangeRequestRequest
} from "../../change-request/contracts.js";

type RunGh = (cwd: string, args: readonly string[]) => Promise<string>;
type ChangeRequestError = Error & {
  code: "change_request_create_failed";
  cause?: unknown;
};

const execFileAsync = promisify(execFile);

function skipped(
  enabled: boolean,
  reason: string
): { enabled: boolean; skipped: true; reason: string } {
  return { enabled, skipped: true, reason };
}

async function defaultRunGh(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", [...args], { cwd });

  return stdout;
}

function changeRequestError(message: string, cause: unknown): ChangeRequestError {
  const error = new Error(message, { cause }) as ChangeRequestError;
  error.code = "change_request_create_failed";

  return error;
}

export type OpenGitHubChangeRequestInput = OpenChangeRequestRequest & {
  runGh?: RunGh;
};

export async function openGitHubChangeRequest({
  enabled,
  cwd,
  push,
  branch,
  baseRef,
  draft,
  title,
  body,
  runGh = defaultRunGh
}: OpenGitHubChangeRequestInput): Promise<ChangeRequestArtifact> {
  if (!enabled) {
    return skipped(false, "disabled");
  }

  if (push.skipped) {
    return skipped(true, "no_push");
  }

  if (push.branch !== branch) {
    return skipped(true, "branch_mismatch");
  }

  if (baseRef === undefined || baseRef.trim() === "") {
    return skipped(true, "base_ref_missing");
  }

  try {
    await runGh(cwd, ["auth", "status"]);
  } catch {
    return skipped(true, "gh_not_authenticated");
  }

  const args = ["pr", "create"];

  if (draft) {
    args.push("--draft");
  }

  args.push("--base", baseRef, "--head", branch, "--title", title);

  if (body !== undefined) {
    args.push("--body", body);
  }

  let url: string;
  try {
    url = (await runGh(cwd, args)).trim();
  } catch (cause) {
    throw changeRequestError("Failed to create GitHub change request", cause);
  }

  return {
    enabled: true,
    skipped: false,
    provider: "github",
    ...(url === "" ? {} : { url })
  };
}

export const githubChangeRequestProvider: ChangeRequestProvider = {
  provider: "github",
  open: openGitHubChangeRequest
};
