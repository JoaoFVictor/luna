import { constants } from "node:fs";

export const REPOSITORY_INDEXER_VERSION = "repository-context-index-v7";
export const REPOSITORY_CONTEXT_EXCLUDED_DIRECTORIES = [
  ".agents",
  ".claude",
  ".codex",
  ".cursor"
] as const;
const REPOSITORY_CONTEXT_EXCLUDED_DIRECTORY_SET = new Set<string>(
  REPOSITORY_CONTEXT_EXCLUDED_DIRECTORIES
);
export const REPOSITORY_CONTEXT_EXCLUDED_INSTRUCTION_FILES = [
  ".cursorrules",
  "agents.md",
  "claude.md",
  "codex.md",
  "copilot-instructions.md",
  "gemini.md"
] as const;
export const REPOSITORY_CONTEXT_EXCLUDED_INSTRUCTION_SUFFIXES = [
  ".instructions.md"
] as const;
export const REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_FILES = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa"
] as const;
const REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_DIRECTORIES = [
  ".aws",
  ".azure",
  ".gnupg",
  ".ssh"
] as const;
export const REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_SUFFIXES = [
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx"
] as const;
const REPOSITORY_CONTEXT_EXCLUDED_INSTRUCTION_FILE_SET = new Set<string>(
  REPOSITORY_CONTEXT_EXCLUDED_INSTRUCTION_FILES
);
const REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_FILE_SET = new Set<string>(
  REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_FILES
);

// Process safety policy, intentionally not workflow configuration. Capacity
// never changes ranking or truncates a prefix: the complete eligible index is
// produced, or the build fails with structured diagnostics.
export const REPOSITORY_INDEX_RESOURCE_POLICY = Object.freeze({
  max_file_source_bytes: 4 * 1024 * 1024,
  max_total_source_bytes: 96 * 1024 * 1024,
  max_retained_index_bytes: 192 * 1024 * 1024,
  max_build_working_bytes: 256 * 1024 * 1024,
  max_inflight_source_bytes: 8 * 1024 * 1024,
  max_read_concurrency: 8,
  max_concurrent_index_operations: 2,
  max_queued_index_operations: 32,
  estimated_index_operation_bytes: 256 * 1024 * 1024,
  estimated_query_operation_bytes: 32 * 1024 * 1024,
  max_process_index_bytes: 512 * 1024 * 1024,
  max_inventory_output_bytes: 64 * 1024 * 1024,
  max_inventory_entries: 200_000,
  max_git_metadata_bytes: 64 * 1024 * 1024,
  max_cache_bytes: 256 * 1024 * 1024
});

export type RepositoryIndexCapacityDiagnostics = {
  readonly phase: "admission" | "inventory" | "preflight" | "read" | "analysis";
  readonly resource:
    | "entries"
    | "file_source_bytes"
    | "git_output_bytes"
    | "process_index_bytes"
    | "queued_operations"
    | "retained_index_bytes"
    | "working_bytes"
    | "total_source_bytes";
  readonly observed: number;
  readonly limit: number;
  readonly path?: string;
};

export class RepositoryIndexCapacityError extends Error {
  readonly code = "repository_index_capacity_exceeded";
  readonly diagnostics: RepositoryIndexCapacityDiagnostics;

  constructor(message: string, diagnostics: RepositoryIndexCapacityDiagnostics) {
    super(message);
    this.name = "RepositoryIndexCapacityError";
    this.diagnostics = diagnostics;
  }
}

export class RepositoryIndexSnapshotChangedError extends Error {
  readonly code = "repository_index_snapshot_changed";

  constructor(filePath?: string) {
    super(filePath === undefined
      ? "Repository changed while its canonical index was being built."
      : `Repository file changed while its canonical index was being built: ${filePath}`);
    this.name = "RepositoryIndexSnapshotChangedError";
  }
}

export type RepositoryContextIndexPolicy = {
  readonly exclude_globs?: readonly string[];
};

function normalizedPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

function globExpression(glob: string): RegExp {
  const normalized = normalizedPath(glob);
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] as string;
    if (character === "*" && normalized[index + 1] === "*") {
      expression += normalized[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += normalized[index + 2] === "/" ? 2 : 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

export function normalizedRepositoryContextPolicy(
  policy?: RepositoryContextIndexPolicy
): Required<RepositoryContextIndexPolicy> {
  const globs = policy?.exclude_globs ?? [];
  if (globs.length > 128) {
    throw new Error("Repository context policy supports at most 128 exclude globs.");
  }
  for (const glob of globs) {
    const segments = glob.replaceAll("\\", "/").split("/");
    if (
      glob.length === 0 ||
      glob.length > 256 ||
      glob.includes("\0") ||
      glob.startsWith("/") ||
      glob.startsWith("\\") ||
      segments.includes("..")
    ) {
      throw new Error(`Invalid repository context exclude glob: ${glob}`);
    }
  }
  return {
    exclude_globs: [...new Set(globs)]
      .map((glob) => normalizedPath(glob))
      .sort()
  };
}

export function repositoryIndexCapacityError(
  input: RepositoryIndexCapacityDiagnostics
): RepositoryIndexCapacityError {
  const pathDetail = input.path === undefined ? "" : ` (${input.path})`;
  return new RepositoryIndexCapacityError(
    `Repository index ${input.phase} exceeded ${input.resource}${pathDetail}: ${input.observed} > ${input.limit}. The complete canonical index was not produced.`,
    input
  );
}

export function repositoryIndexSecureReadFlags(): number {
  if (constants.O_NOFOLLOW === 0) {
    throw new Error("Repository indexing requires operating-system O_NOFOLLOW support.");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

export function isRepositoryContextPolicyExcluded(
  filePath: string,
  policy?: RepositoryContextIndexPolicy
): boolean {
  return repositoryContextPolicyMatcher(policy)(filePath);
}

export function repositoryContextPolicyMatcher(
  policy?: RepositoryContextIndexPolicy
): (filePath: string) => boolean {
  const configured = normalizedRepositoryContextPolicy(policy).exclude_globs
    .map(globExpression);
  return (filePath: string): boolean => {
    const normalized = normalizedPath(filePath);
    const segments = normalized.split("/");
    const basename = segments.at(-1) ?? "";
    return segments.some((segment) => REPOSITORY_CONTEXT_EXCLUDED_DIRECTORY_SET.has(segment)) ||
      segments.some((segment) =>
        (REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_DIRECTORIES as readonly string[]).includes(segment)
      ) ||
      normalized.startsWith(".config/gcloud/") ||
      REPOSITORY_CONTEXT_EXCLUDED_INSTRUCTION_FILE_SET.has(basename) ||
      REPOSITORY_CONTEXT_EXCLUDED_INSTRUCTION_SUFFIXES.some((suffix) => basename.endsWith(suffix)) ||
      basename === ".env" ||
      basename.startsWith(".env.") ||
      REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_FILE_SET.has(basename) ||
      REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_SUFFIXES.some((suffix) => basename.endsWith(suffix)) ||
      configured.some((expression) => expression.test(normalized));
  };
}

export function repositoryIndexPolicyMaterial(policy?: RepositoryContextIndexPolicy): string {
  return JSON.stringify({
    indexer_version: REPOSITORY_INDEXER_VERSION,
    resource_policy: REPOSITORY_INDEX_RESOURCE_POLICY,
    excluded_directories: REPOSITORY_CONTEXT_EXCLUDED_DIRECTORIES,
    excluded_instruction_files: REPOSITORY_CONTEXT_EXCLUDED_INSTRUCTION_FILES,
    excluded_instruction_suffixes: REPOSITORY_CONTEXT_EXCLUDED_INSTRUCTION_SUFFIXES,
    excluded_sensitive_files: REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_FILES,
    excluded_sensitive_suffixes: REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_SUFFIXES,
    excluded_sensitive_directories: REPOSITORY_CONTEXT_EXCLUDED_SENSITIVE_DIRECTORIES,
    configured: normalizedRepositoryContextPolicy(policy)
  });
}

export function containsDeterministicCredentialMaterial(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("utf8");
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u.test(text) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(text) ||
    /"(?:client_secret|private_key|private_key_id)"\s*:\s*"(?!\$\{|<|example|changeme|redacted)[^"\r\n]{8,}"/iu.test(text);
}
