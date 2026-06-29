import path from "node:path";

export type LunaAuthEnv = {
  LUNA_AUTH_ROOT?: string;
};

export function resolveLunaAuthRoot(
  projectRoot = process.cwd(),
  env: LunaAuthEnv = process.env
): string {
  const configured = env.LUNA_AUTH_ROOT?.trim();
  if (configured !== undefined && configured !== "") {
    return path.isAbsolute(configured)
      ? configured
      : path.join(projectRoot, configured);
  }

  return path.join(projectRoot, ".luna", "auth");
}

export function resolveLunaAuthFilePath(
  projectRoot = process.cwd(),
  env: LunaAuthEnv = process.env
): string {
  return path.join(resolveLunaAuthRoot(projectRoot, env), "luna.auth.json");
}
