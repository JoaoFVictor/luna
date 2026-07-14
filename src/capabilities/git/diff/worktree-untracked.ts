import { Buffer } from "node:buffer";
import { redactString } from "../../../core/security/redactor.js";
import { openFileBeneath } from "../../../core/security/secure-root-file.js";
import type {
  FileExcerpt,
  UntrackedFileSummary
} from "./worktree-diff-contracts.js";

export function truncateUtf8ToBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  let bytesUsed = 0;
  let truncated = "";
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytesUsed + characterBytes > maxBytes) {
      break;
    }
    truncated += character;
    bytesUsed += characterBytes;
  }
  return truncated;
}

function excerptForContent(content: string, maxBytes: number): FileExcerpt {
  const truncated = Buffer.byteLength(content, "utf8") > maxBytes;
  const excerptContent = redactString(
    truncated ? truncateUtf8ToBytes(content, maxBytes) : content
  );
  const lines = excerptContent.length === 0 ? 1 : excerptContent.split("\n").length;
  return {
    start_line: 1,
    end_line: excerptContent.endsWith("\n") ? Math.max(1, lines - 1) : lines,
    content: excerptContent,
    ...(truncated ? { truncated: true } : {})
  };
}

function isSensitiveUntrackedPath(path: string): boolean {
  const basename = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  return basename === ".npmrc" || basename === ".yarnrc" || basename === ".pypirc" ||
    basename === ".netrc" || basename === "credentials" || basename === "credentials.json" ||
    basename === "luna.auth.json" || basename.startsWith(".env");
}

async function summarizeUntrackedFile(
  cwd: string,
  path: string,
  maxBytes: number
): Promise<UntrackedFileSummary> {
  let bytes = 0;
  const emptyExcerpt = excerptForContent("", maxBytes);
  let handle: Awaited<ReturnType<typeof openFileBeneath>> = undefined;
  const omitted = (reason: UntrackedFileSummary["omitted_reason"]): UntrackedFileSummary => ({
    path,
    excerpt: emptyExcerpt,
    truncated: false,
    bytes,
    max_bytes: maxBytes,
    omitted: true,
    omitted_reason: reason
  });
  try {
    handle = await openFileBeneath(cwd, path);
    if (handle === undefined) {
      return omitted("unavailable_or_unsafe");
    }
    const stats = await handle.stat();
    bytes = stats.size;
    if (!stats.isFile()) {
      return omitted("non_regular");
    }
    if (isSensitiveUntrackedPath(path)) {
      return omitted("sensitive_path");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const excerpt = excerptForContent(buffer.subarray(0, bytesRead).toString("utf8"), maxBytes);
    return {
      path,
      excerpt,
      truncated: excerpt.truncated === true,
      bytes,
      max_bytes: maxBytes
    };
  } catch {
    return omitted("unavailable_or_unsafe");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function summarizeUntrackedFiles(
  cwd: string,
  paths: readonly string[],
  maxBytes: number,
  concurrency: number
): Promise<UntrackedFileSummary[]> {
  const results = new Array<UntrackedFileSummary>(paths.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < paths.length) {
      const index = cursor++;
      const path = paths[index];
      if (path !== undefined) {
        results[index] = await summarizeUntrackedFile(cwd, path, maxBytes);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()));
  return results;
}
