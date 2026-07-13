import { z, ZodError } from "zod";
import {
  loadLunaAuthFile,
  lunaAuthError,
  type LunaAuthError
} from "../../core/auth/luna-auth-file.js";
import type { LunaAuthEnv } from "../../core/auth/root.js";

const NonEmptyStringSchema = z.string().min(1);

export const XLunaAuthConfigSchema = z
  .object({
    providers: z
      .object({
        x: z
          .record(
            z
              .object({
                auth_type: z.literal("oauth2_user_access_token"),
                access_token: NonEmptyStringSchema
              })
              .strict()
          )
          .optional()
      })
      .catchall(z.unknown())
  })
  .strict();

export type XLunaAuthConfig = z.infer<typeof XLunaAuthConfigSchema>;
export type XAuth = NonNullable<XLunaAuthConfig["providers"]["x"]>[string];

export type XAuthError = (LunaAuthError | Error) & {
  code: "luna_auth_missing" | "luna_auth_invalid" | "x_auth_missing";
  cause?: unknown;
};

function xAuthError(
  code: XAuthError["code"],
  message: string,
  cause?: unknown
): XAuthError {
  if (code === "luna_auth_missing" || code === "luna_auth_invalid") {
    return lunaAuthError(code, message, cause) as XAuthError;
  }

  const error = new Error(message, { cause }) as XAuthError;
  error.code = code;
  error.cause = cause;
  return error;
}

export async function loadXAuth(
  projectRoot = process.cwd(),
  env: LunaAuthEnv = process.env
): Promise<XLunaAuthConfig> {
  const authFile = await loadLunaAuthFile(projectRoot, env);

  try {
    return XLunaAuthConfigSchema.parse(authFile);
  } catch (cause) {
    if (cause instanceof ZodError) {
      throw xAuthError(
        "luna_auth_invalid",
        "Luna auth X provider failed schema validation",
        cause
      );
    }
    throw cause;
  }
}

export function xAuthForInstance(auth: XLunaAuthConfig, instanceId: string): XAuth {
  const instance = auth.providers.x?.[instanceId];
  if (instance === undefined) {
    throw xAuthError(
      "x_auth_missing",
      `X auth is not configured for instance: ${instanceId}`
    );
  }
  return instance;
}
