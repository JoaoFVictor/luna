import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { GitObjectIdSchema } from "./diff/types.js";
import { runGit } from "./client.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_TIMEOUT_MS = 60_000;
const SNAPSHOT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_PATHS = 10_000;

const RepositoryPathSchema = z.string().min(1).max(4_096);

export const ApprovedWorktreeSnapshotSchema = z.object({
  kind: z.literal("git_worktree_tree.v1"),
  head_sha: GitObjectIdSchema,
  tree_oid: GitObjectIdSchema,
  changed_paths: z.array(RepositoryPathSchema).max(SNAPSHOT_MAX_PATHS)
}).strict();
export type ApprovedWorktreeSnapshot = z.infer<typeof ApprovedWorktreeSnapshotSchema>;

type RunGitWithEnvironment = (
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal
) => Promise<string>;

async function defaultRunGitWithEnvironment(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: environment,
    timeout: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: SNAPSHOT_MAX_OUTPUT_BYTES,
    ...(signal === undefined ? {} : { signal })
  });
  return stdout;
}

function absoluteGitPath(cwd: string, value: string): string {
  const resolved = value.trim();
  if (resolved === "") {
    throw new Error("Git returned an empty repository path while capturing a worktree snapshot.");
  }
  return path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved);
}

function nulPaths(output: string): string[] {
  const paths = output.split("\0").filter((value) => value !== "");
  if (paths.length > SNAPSHOT_MAX_PATHS) {
    throw new Error(
      `Approved worktree snapshot exceeds ${SNAPSHOT_MAX_PATHS} changed paths.`
    );
  }
  return [...new Set(paths)].sort();
}

function snapshotEnvironment(input: {
  readonly indexPath: string;
  readonly objectDirectory?: string;
  readonly alternateObjectDirectory?: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_INDEX_FILE: input.indexPath,
    GIT_OPTIONAL_LOCKS: "0",
    ...(input.objectDirectory === undefined
      ? {}
      : { GIT_OBJECT_DIRECTORY: input.objectDirectory }),
    ...(input.alternateObjectDirectory === undefined
      ? {}
      : { GIT_ALTERNATE_OBJECT_DIRECTORIES: input.alternateObjectDirectory })
  };
}

async function treeSnapshotFromTemporaryIndex(input: {
  readonly cwd: string;
  readonly indexPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly headSha: string;
  readonly runGitWithEnvironment: RunGitWithEnvironment;
  readonly signal?: AbortSignal;
}): Promise<ApprovedWorktreeSnapshot> {
  const run = async (args: readonly string[]): Promise<string> =>
    await input.runGitWithEnvironment(
      input.cwd,
      args,
      input.environment,
      input.signal
    );

  await run(["read-tree", input.headSha]);
  await run(["--literal-pathspecs", "add", "-A", "--", "."]);
  const treeOid = (await run(["write-tree"])).trim();
  const changedPaths = nulPaths(await run([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    input.headSha,
    "--"
  ]));

  return ApprovedWorktreeSnapshotSchema.parse({
    kind: "git_worktree_tree.v1",
    head_sha: input.headSha,
    tree_oid: treeOid,
    changed_paths: changedPaths
  });
}

export function worktreeSnapshotsEqual(
  left: ApprovedWorktreeSnapshot,
  right: ApprovedWorktreeSnapshot
): boolean {
  return left.head_sha === right.head_sha &&
    left.tree_oid === right.tree_oid &&
    JSON.stringify(left.changed_paths) === JSON.stringify(right.changed_paths);
}

/**
 * Captures the complete non-ignored worktree as a Git tree without changing
 * the repository index or object database. A temporary index stages file
 * modes, binary blobs, symlinks, additions, deletions, and renames using Git's
 * own semantics; a temporary object database reads existing objects through
 * alternates and receives only dangling snapshot objects.
 */
export async function captureApprovedWorktreeSnapshot(input: {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly runGitCommand?: typeof runGit;
  readonly runGitWithEnvironment?: RunGitWithEnvironment;
}): Promise<ApprovedWorktreeSnapshot> {
  input.signal?.throwIfAborted();
  const runGitCommand = input.runGitCommand ?? runGit;
  const runGitWithEnvironment = input.runGitWithEnvironment ?? defaultRunGitWithEnvironment;
  const [headSha, rawObjectDirectory] = await Promise.all([
    runGitCommand(input.cwd, ["rev-parse", "--verify", "HEAD"]),
    runGitCommand(input.cwd, ["rev-parse", "--git-path", "objects"])
  ]);
  const objectDirectory = absoluteGitPath(input.cwd, rawObjectDirectory);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luna-worktree-snapshot-"));
  const temporaryIndex = path.join(temporaryRoot, "index");
  const temporaryObjects = path.join(temporaryRoot, "objects");
  await mkdir(temporaryObjects, { mode: 0o700 });

  try {
    return await treeSnapshotFromTemporaryIndex({
      cwd: input.cwd,
      indexPath: temporaryIndex,
      environment: snapshotEnvironment({
        indexPath: temporaryIndex,
        objectDirectory: temporaryObjects,
        alternateObjectDirectory: objectDirectory
      }),
      headSha: headSha.trim(),
      runGitWithEnvironment,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readIndexIfPresent(indexPath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(indexPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function replaceRepositoryIndexIfUnchanged(
  indexPath: string,
  stagedIndexPath: string,
  expectedIndex: Buffer | undefined
): Promise<boolean> {
  const lockPath = `${indexPath}.lock`;
  const handle = await open(lockPath, "wx");
  try {
    const currentIndex = await readIndexIfPresent(indexPath);
    const unchanged = currentIndex === undefined
      ? expectedIndex === undefined
      : expectedIndex !== undefined && currentIndex.equals(expectedIndex);
    if (!unchanged) {
      return false;
    }
    const stagedIndex = await readFile(stagedIndexPath);
    await handle.writeFile(stagedIndex);
    await handle.sync();
    await handle.close();
    await rename(lockPath, indexPath);
    return true;
  } catch (cause) {
    throw cause;
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true });
  }
}

/**
 * Commits exactly an approved snapshot through a private index. The candidate
 * index is built off to the side and checked against the approved Git tree;
 * the shared repository index is refreshed only after the exact tree commits.
 */
export async function commitApprovedWorktreeSnapshot(input: {
  readonly cwd: string;
  readonly expected: ApprovedWorktreeSnapshot;
  readonly message: string;
  readonly signal?: AbortSignal;
  readonly runGitCommand?: typeof runGit;
  readonly runGitWithEnvironment?: RunGitWithEnvironment;
}): Promise<{ readonly commit_sha: string; readonly tree_oid: string }> {
  const expected = ApprovedWorktreeSnapshotSchema.parse(input.expected);
  const runGitCommand = input.runGitCommand ?? runGit;
  const runGitWithEnvironment = input.runGitWithEnvironment ?? defaultRunGitWithEnvironment;
  const current = await captureApprovedWorktreeSnapshot({
    cwd: input.cwd,
    runGitCommand,
    runGitWithEnvironment,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (!worktreeSnapshotsEqual(current, expected)) {
    throw new Error("Worktree no longer matches the approved Git tree snapshot.");
  }

  const rawIndexPath = await runGitCommand(input.cwd, ["rev-parse", "--git-path", "index"]);
  const indexPath = absoluteGitPath(input.cwd, rawIndexPath);
  const originalIndex = await readIndexIfPresent(indexPath);
  const temporaryRoot = await mkdtemp(path.join(
    path.dirname(indexPath),
    ".luna-approved-index-"
  ));
  const temporaryIndex = path.join(temporaryRoot, "index");
  try {
    const staged = await treeSnapshotFromTemporaryIndex({
      cwd: input.cwd,
      indexPath: temporaryIndex,
      environment: snapshotEnvironment({ indexPath: temporaryIndex }),
      headSha: expected.head_sha,
      runGitWithEnvironment,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (!worktreeSnapshotsEqual(staged, expected)) {
      throw new Error("Compare-and-stage produced a tree different from the approved snapshot.");
    }
    const verified = await captureApprovedWorktreeSnapshot({
      cwd: input.cwd,
      runGitCommand,
      runGitWithEnvironment,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (!worktreeSnapshotsEqual(verified, expected)) {
      throw new Error("Worktree changed while the approved snapshot was being staged.");
    }
    const finalCheck = await captureApprovedWorktreeSnapshot({
      cwd: input.cwd,
      runGitCommand,
      runGitWithEnvironment,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (!worktreeSnapshotsEqual(finalCheck, expected)) {
      throw new Error("Worktree changed before the approved commit could start.");
    }

    // Create immutable commit content from the approved tree, then advance
    // HEAD with compare-and-swap. Concurrent index writes cannot affect the
    // tree, and a concurrent ref advance makes update-ref fail atomically.
    const commitSha = (await runGitWithEnvironment(
      input.cwd,
      [
        "-c", "core.hooksPath=/dev/null",
        "commit-tree", expected.tree_oid,
        "-p", expected.head_sha,
        "-m", input.message
      ],
      snapshotEnvironment({ indexPath: temporaryIndex }),
      input.signal
    )).trim();
    GitObjectIdSchema.parse(commitSha);
    const committedTree = (await runGitCommand(input.cwd, [
      "rev-parse", `${commitSha}^{tree}`
    ])).trim();
    if (committedTree.trim() !== expected.tree_oid) {
      throw new Error("Committed Git tree does not match the approved snapshot.");
    }
    await runGitCommand(input.cwd, [
      "-c", "core.hooksPath=/dev/null",
      "update-ref", "HEAD", commitSha, expected.head_sha
    ]);

    // Refresh the shared index only if nobody changed it since this operation
    // began. If it drifted, preserve the concurrent writer's index verbatim.
    await replaceRepositoryIndexIfUnchanged(
      indexPath,
      temporaryIndex,
      originalIndex
    );
    return {
      commit_sha: commitSha,
      tree_oid: committedTree
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
