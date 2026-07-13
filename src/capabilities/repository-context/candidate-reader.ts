import { createHash } from "node:crypto";
import path from "node:path";
import { openFileBeneath } from "../../core/security/secure-root-file.js";
import { fileKind, languageFor, type Candidate } from "./file-analysis.js";
import {
  containsDeterministicCredentialMaterial,
  RepositoryIndexSnapshotChangedError
} from "./repository-index-policy.js";
import {
  analyzeFileSymbolGraph,
  importValuesFromGraph,
  symbolNamesFromGraph
} from "./symbol-analysis/index.js";

export type CandidateReadOutcome =
  | { readonly kind: "candidate"; readonly candidate: Candidate }
  | { readonly kind: "binary" }
  | { readonly kind: "sensitive" }
  | { readonly kind: "unavailable" };

export function classifyCandidateBytes(
  bytes: Uint8Array,
  options: { readonly prefix?: boolean } = {}
): "text" | "binary" | "sensitive" {
  if (bytes.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes,
      options.prefix === true ? { stream: true } : undefined
    );
  } catch (cause) {
    if (cause instanceof TypeError) return "binary";
    throw cause;
  }
  return containsDeterministicCredentialMaterial(bytes) ? "sensitive" : "text";
}

function safeAbsolutePath(root: string, relativePath: string): string | undefined {
  const absolutePath = path.resolve(root, relativePath);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootWithSeparator)) {
    return undefined;
  }
  return absolutePath;
}

function candidateFromContent(
  root: string,
  relativePath: string,
  content: string,
  contentDigest: string,
  truncated: boolean
): Candidate | undefined {
  const absolutePath = safeAbsolutePath(root, relativePath);
  if (absolutePath === undefined) {
    return undefined;
  }
  const symbolGraph = analyzeFileSymbolGraph(content, relativePath, { truncated });
  return {
    path: relativePath,
    absolutePath,
    content,
    content_digest: contentDigest,
    truncated,
    language: languageFor(relativePath),
    kind: fileKind(relativePath),
    symbol_graph: symbolGraph,
    symbols: symbolNamesFromGraph(symbolGraph),
    imports: importValuesFromGraph(symbolGraph)
  };
}

export async function readCandidate(
  root: string,
  relativePath: string,
  maxFileBytes: number,
  signal?: AbortSignal
): Promise<Candidate | undefined> {
  const outcome = await readCandidateOutcome(root, relativePath, maxFileBytes, signal);
  return outcome.kind === "candidate" ? outcome.candidate : undefined;
}

export async function readCandidateOutcome(
  root: string,
  relativePath: string,
  maxFileBytes: number,
  signal?: AbortSignal
): Promise<CandidateReadOutcome> {
  signal?.throwIfAborted();
  if (safeAbsolutePath(root, relativePath) === undefined) {
    return { kind: "unavailable" };
  }

  const opened = await openFileBeneath(root, relativePath).catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  });
  if (opened === undefined) {
    return { kind: "unavailable" };
  }

  let content: string;
  let contentDigest: string;
  let truncated: boolean;
  try {
    const before = await opened.stat({ bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { kind: "unavailable" };
    }

    const readLimit = Math.min(Number(before.size), maxFileBytes + 1);
    const buffer = Buffer.alloc(readLimit);
    let offset = 0;
    while (offset < readLimit) {
      signal?.throwIfAborted();
      const read = await opened.read(buffer, offset, readLimit - offset, offset);
      if (read.bytesRead === 0) {
        break;
      }
      offset += read.bytesRead;
    }
    const after = await opened.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    ) {
      throw new RepositoryIndexSnapshotChangedError(relativePath);
    }

    truncated = Number(before.size) > maxFileBytes || offset > maxFileBytes;
    contentDigest = createHash("sha256").update(buffer.subarray(0, offset)).digest("hex");
    const captured = buffer.subarray(0, Math.min(offset, maxFileBytes));
    const classification = classifyCandidateBytes(captured);
    if (classification !== "text") return { kind: classification };
    content = new TextDecoder("utf-8", { fatal: true }).decode(captured);
  } finally {
    await opened.close().catch(() => undefined);
  }
  const candidate = candidateFromContent(root, relativePath, content, contentDigest, truncated);
  return candidate === undefined ? { kind: "unavailable" } : { kind: "candidate", candidate };
}

export function candidateFromCapturedBytes(
  root: string,
  relativePath: string,
  bytes: Buffer,
  maxFileBytes: number
): Candidate | undefined {
  const outcome = candidateOutcomeFromCapturedBytes(root, relativePath, bytes, maxFileBytes);
  return outcome.kind === "candidate" ? outcome.candidate : undefined;
}

export function candidateOutcomeFromCapturedBytes(
  root: string,
  relativePath: string,
  bytes: Buffer,
  maxFileBytes: number
): CandidateReadOutcome {
  if (bytes.length > maxFileBytes) {
    return { kind: "unavailable" };
  }
  const classification = classifyCandidateBytes(bytes);
  if (classification !== "text") return { kind: classification };
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const candidate = candidateFromContent(
    root,
    relativePath,
    content,
    createHash("sha256").update(bytes).digest("hex"),
    false
  );
  return candidate === undefined ? { kind: "unavailable" } : { kind: "candidate", candidate };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMissingFileError(error: unknown): boolean {
  const record = objectRecord(error);
  return record !== undefined && ["ENOENT", "ENOTDIR"].includes(String(record.code));
}
