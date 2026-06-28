import { readFile } from "node:fs/promises";
import { z, ZodError } from "zod";
import {
  resolveLunaAuthFilePath,
  type LunaAuthEnv
} from "./root.js";

export const LunaAuthFileSchema = z
  .object({
    providers: z.record(z.unknown())
  })
  .strict();
export type LunaAuthFile = z.infer<typeof LunaAuthFileSchema>;

export type LunaAuthError = Error & {
  code: "luna_auth_missing" | "luna_auth_invalid";
  cause?: unknown;
};

export function lunaAuthError(
  code: LunaAuthError["code"],
  message: string,
  cause?: unknown
): LunaAuthError {
  const error = new Error(message, { cause }) as LunaAuthError;
  error.code = code;
  error.cause = cause;

  return error;
}

export async function loadLunaAuthFile(
  projectRoot = process.cwd(),
  env: LunaAuthEnv = process.env
): Promise<LunaAuthFile> {
  const authPath = resolveLunaAuthFilePath(projectRoot, env);
  let content: string;

  try {
    content = await readFile(authPath, "utf8");
  } catch (cause) {
    throw lunaAuthError(
      "luna_auth_missing",
      `Luna auth credentials not found at ${authPath}`,
      cause
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw lunaAuthError(
      "luna_auth_invalid",
      `Invalid Luna auth JSON: ${authPath}`,
      cause
    );
  }

  try {
    return LunaAuthFileSchema.parse(parsed);
  } catch (cause) {
    if (cause instanceof ZodError) {
      throw lunaAuthError(
        "luna_auth_invalid",
        `Luna auth failed schema validation: ${authPath}`,
        cause
      );
    }

    throw cause;
  }
}
