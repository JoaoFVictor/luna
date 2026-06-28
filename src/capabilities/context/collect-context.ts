import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { loadAgentDefinition } from "../agents/agent-loader.js";
import type {
  AgentContextCollection,
  CollectContextIntakeInput,
  ContextFileCollection,
  ContextIntake,
  ContextMissingFile,
  ContextReadFile,
  ContextSkippedFile
} from "../../core/context/collect-context-contracts.js";
import { isInsideRoot } from "../../core/security/path.js";

const DEFAULT_MAX_CONTEXT_FILE_BYTES = 64 * 1024;

async function existingFileInsideRoot(
  root: string,
  candidate: string
): Promise<boolean> {
  const rootReal = await realpath(root);
  const candidateReal = await realpath(candidate);

  return isInsideRoot(rootReal, candidateReal);
}

async function collectFiles(input: {
  root: string;
  files: readonly string[];
  maxFileBytes: number;
}): Promise<ContextFileCollection> {
  const root = path.resolve(input.root);
  const read: ContextReadFile[] = [];
  const missing: ContextMissingFile[] = [];
  const skipped: ContextSkippedFile[] = [];

  for (const file of input.files) {
    const candidate = path.resolve(root, file);

    if (!isInsideRoot(root, candidate)) {
      skipped.push({ path: file, reason: "path_escape" });
      continue;
    }

    let candidateStat: Awaited<ReturnType<typeof stat>>;
    try {
      candidateStat = await stat(candidate);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        missing.push({ path: file });
        continue;
      }

      throw cause;
    }

    if (!candidateStat.isFile()) {
      skipped.push({ path: file, reason: "not_file" });
      continue;
    }

    if (!(await existingFileInsideRoot(root, candidate))) {
      skipped.push({ path: file, reason: "path_escape" });
      continue;
    }

    if (candidateStat.size > input.maxFileBytes) {
      skipped.push({
        path: file,
        reason: "too_large",
        bytes: candidateStat.size
      });
      continue;
    }

    const content = await readFile(candidate, "utf8");
    read.push({
      path: file,
      bytes: Buffer.byteLength(content, "utf8"),
      content
    });
  }

  return {
    root,
    configured: input.files,
    read,
    missing,
    skipped
  };
}

export async function collectContextIntake(
  input: CollectContextIntakeInput
): Promise<ContextIntake> {
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_CONTEXT_FILE_BYTES;
  const repository = await collectFiles({
    root: input.repositoryRoot,
    files: input.repository.context?.files ?? [],
    maxFileBytes
  });
  const agents: AgentContextCollection[] = [];

  for (const agentId of input.agentIds) {
    const agent = await loadAgentDefinition(input.agentsRoot, agentId);
    const collection = await collectFiles({
      root: agent.directory,
      files: agent.context?.files ?? [],
      maxFileBytes
    });

    agents.push({
      id: agent.id,
      ...collection
    });
  }

  return { kind: "luna.collect_context.v1", repository, agents };
}
