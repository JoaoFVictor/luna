import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

type StudioStateEnvironment = {
  readonly LUNA_STUDIO_CHECKOUT_ID?: string;
  readonly LUNA_STUDIO_CONTAINER_MODE?: string;
  readonly LUNA_STUDIO_STATE_ROOT?: string;
  readonly XDG_STATE_HOME?: string;
};

const STUDIO_CHECKOUT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{15,47}$/u;

function studioStateIdentity(
  projectRoot: string,
  env: StudioStateEnvironment
): string {
  const configuredIdentity = env.LUNA_STUDIO_CHECKOUT_ID;
  if (configuredIdentity === undefined) {
    if (env.LUNA_STUDIO_CONTAINER_MODE === "1") {
      throw new TypeError(
        "LUNA_STUDIO_CHECKOUT_ID is required in Studio container mode"
      );
    }
    return `project-root\0${path.resolve(projectRoot)}`;
  }
  if (!STUDIO_CHECKOUT_ID_PATTERN.test(configuredIdentity)) {
    throw new TypeError(
      "LUNA_STUDIO_CHECKOUT_ID must be 16-48 lowercase letters, digits, underscores, or hyphens"
    );
  }
  return `checkout-id\0${configuredIdentity}`;
}

export function studioProjectStateRoot(
  projectRoot: string,
  env: StudioStateEnvironment = process.env,
  home = homedir()
): string {
  const base = env.LUNA_STUDIO_STATE_ROOT === undefined
    ? path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "luna", "studio")
    : path.resolve(env.LUNA_STUDIO_STATE_ROOT);
  const projectIdentity = createHash("sha256")
    .update(studioStateIdentity(projectRoot, env))
    .digest("hex");
  return path.join(base, projectIdentity);
}

export function assertStudioStateRootOutsideProject(
  projectRoot: string,
  stateRoot: string
): string {
  const project = path.resolve(projectRoot);
  const state = path.resolve(stateRoot);
  const relative = path.relative(project, state);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  ) {
    throw new TypeError("Studio run state root must be outside the project checkout");
  }
  return state;
}
