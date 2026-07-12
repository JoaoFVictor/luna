import { lstat } from "node:fs/promises";
import path from "node:path";

type StudioContainerEnvironment = {
  readonly LUNA_STUDIO_CONTAINER_MODE?: string;
};

export async function assertSupportedStudioContainerCheckout(
  projectRoot: string,
  env: StudioContainerEnvironment = process.env
): Promise<void> {
  if (env.LUNA_STUDIO_CONTAINER_MODE !== "1") {
    return;
  }

  const gitMetadataPath = path.join(path.resolve(projectRoot), ".git");
  let metadata;
  try {
    metadata = await lstat(gitMetadataPath);
  } catch (cause) {
    throw new TypeError(
      "Studio container mode requires the checkout .git directory to be mounted read-only",
      { cause }
    );
  }
  if (metadata.isFile()) {
    throw new TypeError(
      "Studio Docker does not support linked Git worktrees: .git is a host-only gitfile; use a full clone"
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError(
      "Studio container mode requires .git to be a physical directory"
    );
  }
}
