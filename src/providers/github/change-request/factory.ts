import type {
  ChangeRequestCreateInput,
  ChangeRequestCreatedResult,
  ChangeRequestProviderFactory,
  ChangeRequestState
} from "../../../capabilities/change-request/contracts.js";
import { runGh as defaultRunGh, type RunGh } from "../gh.js";

type ChangeRequestError = Error & {
  code: "change_request_create_failed";
  cause?: unknown;
};

function changeRequestError(message: string, cause: unknown): ChangeRequestError {
  const error = new Error(message, { cause }) as ChangeRequestError;
  error.code = "change_request_create_failed";

  return error;
}

function pullRequestNumberFromUrl(url: string): string | undefined {
  return url.match(/\/pull\/([0-9]+)(?:$|[/?#])/)?.[1];
}

async function createPullRequest(
  input: ChangeRequestCreateInput,
  draft: boolean,
  runGh: RunGh
): Promise<ChangeRequestCreatedResult> {
  const args = ["pr", "create"];

  if (draft) {
    args.push("--draft");
  }

  if (input.target_branch === undefined || input.target_branch.trim() === "") {
    throw changeRequestError("GitHub change request target_branch is required", {
      reason: "target_branch_missing"
    });
  }

  args.push(
    "--base",
    input.target_branch,
    "--head",
    input.source_branch,
    "--title",
    input.title
  );

  args.push("--body", input.description ?? "");

  let url: string;
  try {
    url = (await runGh(input.repository_path, args, { timeoutMs: 60_000 })).trim();
  } catch (cause) {
    throw changeRequestError("Failed to create GitHub change request", cause);
  }
  if (url === "") {
    throw changeRequestError("GitHub change request creation returned no URL", {
      reason: "url_missing"
    });
  }
  const externalId = pullRequestNumberFromUrl(url);
  if (externalId === undefined) {
    throw changeRequestError(
      "GitHub change request creation returned an unparseable PR URL",
      { reason: "external_id_missing", url }
    );
  }

  return {
    operation_id: "change-request.create",
    enabled: true,
    skipped: false,
    provider: "github",
    provider_id: "github",
    external_id: externalId,
    url,
    title: input.title,
    source_branch: input.source_branch,
    target_branch: input.target_branch,
    adopted: false
  };
}

export type GitHubChangeRequestProviderFactoryOptions = {
  readonly draft?: boolean;
  readonly runGh?: RunGh;
};

function parseFirstPullRequest(
  output: string,
  input: ChangeRequestCreateInput
): ChangeRequestState | undefined {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return undefined;
  }

  const candidate = parsed[0] as {
    number?: unknown;
    url?: unknown;
    title?: unknown;
    baseRefName?: unknown;
    headRefName?: unknown;
  };
  if (
    typeof candidate.number !== "number" ||
    typeof candidate.url !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.baseRefName !== "string" ||
    candidate.title !== input.title ||
    candidate.headRefName !== input.source_branch
  ) {
    return undefined;
  }
  if (
    input.target_branch !== undefined &&
    candidate.baseRefName !== input.target_branch
  ) {
    return undefined;
  }

  return {
    operation_id: "change-request.create",
    provider_id: "github",
    external_id: String(candidate.number),
    url: candidate.url,
    title: candidate.title,
    source_branch: input.source_branch,
    target_branch: candidate.baseRefName
  };
}

export function createGitHubChangeRequestProviderFactory({
  draft = false,
  runGh = defaultRunGh
}: GitHubChangeRequestProviderFactoryOptions): ChangeRequestProviderFactory {
  return {
    provider_id: "github",
    createProvider() {
      return {
        provider_id: "github",
        async readChangeRequest(input) {
          const cwd = input.repository_path;
          const args = [
            "pr",
            "list",
            "--head",
            input.source_branch,
            "--json",
            "number,url,title,headRefName,baseRefName",
            "--limit",
            "1"
          ];

          if (input.target_branch !== undefined) {
            args.push("--base", input.target_branch);
          }

          try {
            return parseFirstPullRequest(
              await runGh(cwd, args, { timeoutMs: 60_000 }),
              input
            );
          } catch (cause) {
            throw changeRequestError("Failed to read GitHub change request", cause);
          }
        },
        async createChangeRequest(input) {
          return await createPullRequest(input, input.draft ?? draft, runGh);
        }
      };
    }
  };
}
