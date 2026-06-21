import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codeForArgs, gitError } from "./errors.js";

const execFileAsync = promisify(execFile);

export async function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs = 60000
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      timeout: timeoutMs
    });

    return stdout;
  } catch (cause) {
    throw gitError(
      `Git command failed: git ${args.join(" ")}`,
      codeForArgs(args),
      cause
    );
  }
}
