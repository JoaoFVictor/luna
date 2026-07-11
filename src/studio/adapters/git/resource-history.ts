import path from "node:path";
import { studioAuthoringContentDigest } from "../../application/drafts/authoring-digests.js";
import {
  studioEditableDefinitionFile,
  studioEditableResourceDirectory
} from "../../application/drafts/authoring-resource-paths.js";
import { StudioResourceHistoryError } from "../../application/history/errors.js";
import type {
  StudioHistoricalResourceFile,
  StudioHistoricalResourceSnapshot,
  StudioResourceHistoryPage,
  StudioResourceHistoryPort
} from "../../application/history/ports.js";
import {
  StudioGitRevisionIdSchema,
  StudioHistoryResourceSchema,
  StudioResourceHistoryRevisionSchema,
  STUDIO_RESOURCE_HISTORY_LIMITS,
  type StudioGitRevisionId,
  type StudioHistoryResource,
  type StudioResourceHistoryRevision
} from "../../contracts/resource-history.js";
import {
  historicalResourcePaths,
  validateHistoricalResourceFiles
} from "./historical-resource.js";
import {
  StudioGitProcessError,
  runStudioGitRead,
  type StudioGitReadRequest,
  type StudioGitReadResult,
  type StudioGitReadRunner
} from "./read-process.js";
import {
  parseStudioGitBatch,
  parseStudioGitTree,
  type StudioGitTreeEntry
} from "./tree-codec.js";
import {
  assertStudioGitRevisionReachable,
  loadStudioGitRepositoryContext,
  type StudioGitRepositoryContext
} from "./repository-context.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_HISTORY_OUTPUT_BYTES = 256 * 1024;
const MAX_TREE_OUTPUT_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 256;
const GIT_REGULAR_BLOB_MODES = new Set(["100644", "100755"]);

export type GitStudioResourceHistoryOptions = {
  readonly projectRoot: string;
  readonly runGit?: StudioGitReadRunner;
  readonly timeoutMs?: number;
};

function gitFailure(cause: unknown): StudioResourceHistoryError {
  if (
    cause instanceof StudioGitProcessError &&
    cause.reason === "stdout_too_large"
  ) {
    return new StudioResourceHistoryError(
      "studio_history_source_too_large",
      "Git history output exceeds the Studio limit",
      { cause }
    );
  }
  return new StudioResourceHistoryError(
    "studio_history_git_failed",
    "The entity-scoped Git history operation failed",
    { cause }
  );
}

function decodeUtf8(output: Uint8Array, label: string): string {
  try {
    return UTF8_DECODER.decode(output);
  } catch (cause) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      `${label} is not valid UTF-8`,
      { cause }
    );
  }
}

function safeSubject(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = [...normalized]
    .slice(0, STUDIO_RESOURCE_HISTORY_LIMITS.maxSubjectCharacters)
    .join("");
  return bounded === "" ? "(no subject)" : bounded;
}

function committedAt(rawSeconds: string): string {
  if (!/^(?:0|[1-9][0-9]{0,12})$/u.test(rawSeconds)) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      "Git returned an invalid commit timestamp"
    );
  }
  const milliseconds = Number(rawSeconds) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      "Git returned an unsupported commit timestamp"
    );
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      "Git returned an unsupported commit timestamp"
    );
  }
  return date.toISOString();
}

function parseHistory(output: Uint8Array): readonly StudioResourceHistoryRevision[] {
  const values = decodeUtf8(output, "Git history metadata").split("\0");
  const trailing = values.pop();
  if ((trailing ?? "").trim() !== "" || values.length % 3 !== 0) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      "Git returned malformed history metadata"
    );
  }
  const revisions: StudioResourceHistoryRevision[] = [];
  for (let index = 0; index < values.length; index += 3) {
    const rawRevision = values[index]?.replace(/^\n/u, "");
    const rawTimestamp = values[index + 1];
    const rawSubject = values[index + 2];
    const revision = StudioGitRevisionIdSchema.safeParse(rawRevision);
    if (
      !revision.success ||
      rawTimestamp === undefined ||
      rawSubject === undefined
    ) {
      throw new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "Git returned incomplete history metadata"
      );
    }
    revisions.push(
      StudioResourceHistoryRevisionSchema.parse({
        revision_id: revision.data,
        committed_at: committedAt(rawTimestamp),
        subject: safeSubject(rawSubject)
      })
    );
  }
  return revisions;
}

function assertRegularBlob(
  entry: StudioGitTreeEntry,
  resource: StudioHistoryResource
): asserts entry is StudioGitTreeEntry & { readonly size: number } {
  if (
    entry.type !== "blob" ||
    !GIT_REGULAR_BLOB_MODES.has(entry.mode) ||
    entry.size === null
  ) {
    throw new StudioResourceHistoryError(
      "studio_history_resource_invalid",
      "A historical resource file is not a regular Git blob",
      { details: { resource } }
    );
  }
  if (entry.size > STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFileBytes) {
    throw new StudioResourceHistoryError(
      "studio_history_source_too_large",
      "A historical resource file exceeds the Studio limit",
      {
        details: {
          resource,
          actualBytes: entry.size,
          maxBytes: STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFileBytes
        }
      }
    );
  }
}

function selectedTreeEntries(
  tree: readonly StudioGitTreeEntry[],
  paths: readonly { readonly path: string }[],
  resource: StudioHistoryResource
): readonly (StudioGitTreeEntry & { readonly size: number })[] {
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  let totalBytes = 0;
  const selected = paths.map((file) => {
    const entry = byPath.get(file.path);
    if (entry === undefined) {
      throw new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "A historical resource is missing a referenced file",
        { details: { resource } }
      );
    }
    assertRegularBlob(entry, resource);
    totalBytes += entry.size;
    return entry;
  });
  if (
    selected.length > STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFiles ||
    totalBytes > STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotBytes
  ) {
    throw new StudioResourceHistoryError(
      "studio_history_source_too_large",
      "The historical resource exceeds Studio snapshot limits",
      {
        details: {
          resource,
          actualBytes: totalBytes,
          maxBytes: STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotBytes,
          actualFiles: selected.length,
          maxFiles: STUDIO_RESOURCE_HISTORY_LIMITS.maxSnapshotFiles
        }
      }
    );
  }
  return selected;
}

export class GitStudioResourceHistory implements StudioResourceHistoryPort {
  private readonly projectRoot: string;
  private readonly runGit: StudioGitReadRunner;
  private readonly timeoutMs: number | undefined;

  constructor(options: GitStudioResourceHistoryOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.runGit = options.runGit ?? runStudioGitRead;
    this.timeoutMs = options.timeoutMs;
  }

  async list(
    resourceInput: StudioHistoryResource,
    options: { readonly limit: number }
  ): Promise<StudioResourceHistoryPage> {
    const resource = StudioHistoryResourceSchema.parse(resourceInput);
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > STUDIO_RESOURCE_HISTORY_LIMITS.maxRevisions
    ) {
      throw new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "The Git history limit is invalid",
        { details: { resource } }
      );
    }
    try {
      const repository = await this.repositoryContext();
      const result = await this.command(repository.root, {
        args: [
          "log",
          "--no-renames",
          "--no-decorate",
          "--no-show-signature",
          "--encoding=UTF-8",
          `--max-count=${options.limit + 1}`,
          "--format=%H%x00%ct%x00%s%x00",
          repository.head,
          "--",
          studioEditableResourceDirectory(resource)
        ],
        maxStdoutBytes: MAX_HISTORY_OUTPUT_BYTES
      });
      const revisions = parseHistory(result.stdout);
      return {
        revisions: revisions.slice(0, options.limit),
        truncated: revisions.length > options.limit
      };
    } catch (cause) {
      if (cause instanceof StudioResourceHistoryError) {
        throw cause;
      }
      throw gitFailure(cause);
    }
  }

  async snapshot(
    resourceInput: StudioHistoryResource,
    revisionInput: StudioGitRevisionId
  ): Promise<StudioHistoricalResourceSnapshot> {
    const resource = StudioHistoryResourceSchema.parse(resourceInput);
    const revisionId = StudioGitRevisionIdSchema.parse(revisionInput);
    try {
      const repository = await this.repositoryContext();
      await assertStudioGitRevisionReachable(
        repository,
        revisionId,
        resource,
        this.command.bind(this)
      );
      const tree = await this.readTree(repository, resource, revisionId);
      const definitionPath = studioEditableDefinitionFile(resource);
      const definitionEntry = tree.find(
        (entry) => entry.path === definitionPath.path
      );
      if (definitionEntry === undefined) {
        throw new StudioResourceHistoryError(
          "studio_history_resource_not_found",
          "The resource does not exist at the selected revision",
          { details: { resource } }
        );
      }
      assertRegularBlob(definitionEntry, resource);
      const definitionBlobs = await this.readBlobs(
        repository,
        [definitionEntry]
      );
      const definition = decodeUtf8(
        definitionBlobs.get(definitionEntry.objectId) ?? Buffer.alloc(0),
        "Historical resource definition"
      );
      const paths = historicalResourcePaths(resource, definition);
      const entries = selectedTreeEntries(tree, paths, resource);
      const blobs = await this.readBlobs(repository, entries);
      const files: StudioHistoricalResourceFile[] = paths.map((file, index) => {
        const entry = entries[index];
        if (entry === undefined) {
          throw new StudioResourceHistoryError(
            "studio_history_resource_invalid",
            "Historical resource projection is incomplete",
            { details: { resource } }
          );
        }
        const content = blobs.get(entry.objectId);
        if (content === undefined) {
          throw new StudioResourceHistoryError(
            "studio_history_resource_invalid",
            "Historical resource content is incomplete",
            { details: { resource } }
          );
        }
        return {
          file,
          content,
          sha256: studioAuthoringContentDigest(content),
          mode: Number.parseInt(entry.mode, 8) & 0o777
        };
      });
      validateHistoricalResourceFiles(resource, files);
      return { resource, revisionId, files };
    } catch (cause) {
      if (cause instanceof StudioResourceHistoryError) {
        throw cause;
      }
      throw gitFailure(cause);
    }
  }

  private async repositoryContext(): Promise<StudioGitRepositoryContext> {
    return await loadStudioGitRepositoryContext(
      this.projectRoot,
      this.command.bind(this)
    );
  }

  private async readTree(
    repository: StudioGitRepositoryContext,
    resource: StudioHistoryResource,
    revisionId: StudioGitRevisionId
  ): Promise<readonly StudioGitTreeEntry[]> {
    const directory = studioEditableResourceDirectory(resource);
    const result = await this.command(repository.root, {
      args: [
        "ls-tree",
        "-l",
        "-r",
        "-z",
        "--full-tree",
        revisionId,
        "--",
        directory
      ],
      maxStdoutBytes: MAX_TREE_OUTPUT_BYTES
    });
    const tree = parseStudioGitTree(result.stdout, {
      maxEntries: MAX_TREE_ENTRIES
    });
    if (
      tree.some(
        (entry) =>
          entry.path !== directory &&
          !entry.path.startsWith(`${directory}/`)
      )
    ) {
      throw new StudioResourceHistoryError(
        "studio_history_resource_invalid",
        "Git returned a tree entry outside the requested entity",
        { details: { resource } }
      );
    }
    return tree;
  }

  private async readBlobs(
    repository: StudioGitRepositoryContext,
    entries: readonly (StudioGitTreeEntry & { readonly size: number })[]
  ): Promise<ReadonlyMap<string, Buffer>> {
    const expectedBytes = entries.reduce(
      (total, entry) => total + entry.size,
      0
    );
    const stdin = Buffer.from(
      `${entries.map((entry) => entry.objectId).join("\n")}\n`,
      "ascii"
    );
    const result = await this.command(repository.root, {
      args: ["cat-file", "--batch"],
      stdin,
      maxStdoutBytes: expectedBytes + entries.length * 128 + 1
    });
    return parseStudioGitBatch(result.stdout, entries);
  }

  private async command(
    cwd: string,
    request: Omit<StudioGitReadRequest, "cwd" | "timeoutMs">
  ): Promise<StudioGitReadResult> {
    return await this.runGit({
      cwd,
      ...request,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs })
    });
  }
}
