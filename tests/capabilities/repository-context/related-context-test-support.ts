import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "../../../src/capabilities/git/client.js";
import type { RepoContext } from "../../../src/capabilities/git/diff/types.js";
import type { WorkflowState } from "../../../src/core/workflow/state.js";

export async function write(root: string, filePath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

export async function initializeGitRepository(root: string): Promise<void> {
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, [
    "-c", "user.name=Luna", "-c", "user.email=luna@example.test",
    "commit", "--allow-empty", "--quiet", "-m", "repository context fixture"
  ]);
}

export async function repoContext(
  root: string,
  files: RepoContext["files"]
): Promise<RepoContext> {
  const headSha = (await runGit(root, ["rev-parse", "--verify", "HEAD"])).trim();
  return repoContextAtSha(files, headSha);
}

export function repoContextAtSha(
  files: RepoContext["files"],
  headSha = "a".repeat(40)
): RepoContext {
  const changedFileLimit = Math.max(1, files.length);
  return {
    repository: {
      owner: "octo-org",
      name: "hello-world",
      full_name: "octo-org/hello-world"
    },
    base_sha: headSha,
    head_sha: headSha,
    merge_base: headSha,
    files,
    changed_files_truncated: false,
    total_changed_files: files.length,
    changed_file_limit: changedFileLimit,
    changed_files_omitted_count: 0,
    file_excerpts_truncated: files
      .filter((file) => file.excerpt?.truncated === true)
      .map((file) => file.path),
    git: {
      merge_base: headSha,
      status_short: [],
      status_short_omitted_count: 0,
      status_short_truncated_count: 0
    }
  };
}

export function stateFor(root: string): WorkflowState {
  return {
    invocation: {},
    repository: {
      id: "repo",
      provider: "github",
      owner: "octo-org",
      name: "hello-world",
      default_branch: "main",
      path: root
    },
    workspace: { path: root },
    run: { run_id: "run-1" },
    workflow: { id: "code-review", mode: "read_only" },
    steps: {}
  };
}
