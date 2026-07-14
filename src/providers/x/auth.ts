import { z, ZodError } from "zod";
import {
  loadLunaAuthFile,
  lunaAuthError,
  type LunaAuthError
} from "../../core/auth/luna-auth-file.js";
import { writeFileAtomically } from "../../core/filesystem/atomic-write.js";
import {
  resolveLunaAuthFilePath,
  type LunaAuthEnv
} from "../../core/auth/root.js";

const NonEmptyStringSchema = z.string().min(1);

const XAccessTokenAuthSchema = z
  .object({
    auth_type: z.literal("oauth2_user_access_token"),
    access_token: NonEmptyStringSchema
  })
  .strict();

const XRefreshableAuthSchema = XAccessTokenAuthSchema.extend({
  refresh_token: NonEmptyStringSchema,
  client_id: NonEmptyStringSchema,
  client_secret: NonEmptyStringSchema.optional(),
  expires_at: z.string().datetime({ offset: true }).optional()
}).strict();

export const XAuthSchema = z.union([
  XRefreshableAuthSchema,
  XAccessTokenAuthSchema
]);

export const XLunaAuthConfigSchema = z
  .object({
    providers: z
      .object({
        x: z
          .record(
            XAuthSchema
          )
          .optional()
      })
      .catchall(z.unknown())
  })
  .strict();

export type XLunaAuthConfig = z.infer<typeof XLunaAuthConfigSchema>;
export type XAuth = NonNullable<XLunaAuthConfig["providers"]["x"]>[string];
export type XRefreshableAuth = z.infer<typeof XRefreshableAuthSchema>;

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

export function isXRefreshableAuth(auth: XAuth): auth is XRefreshableAuth {
  return "refresh_token" in auth && "client_id" in auth;
}

export async function persistXAuthInstance(
  projectRoot: string,
  instanceId: string,
  instance: XAuth,
  env: LunaAuthEnv = process.env
): Promise<void> {
  const validatedInstance = XAuthSchema.parse(instance);
  const authFile = await loadLunaAuthFile(projectRoot, env);
  const existingX = authFile.providers.x;
  if (
    existingX !== undefined &&
    (
      typeof existingX !== "object" ||
      existingX === null ||
      Array.isArray(existingX)
    )
  ) {
    throw xAuthError(
      "luna_auth_invalid",
      "Luna auth X provider must be an object before credentials can be updated"
    );
  }

  const updated = {
    ...authFile,
    providers: {
      ...authFile.providers,
      x: {
        ...(existingX ?? {}),
        [instanceId]: validatedInstance
      }
    }
  };

  await writeFileAtomically(
    resolveLunaAuthFilePath(projectRoot, env),
    `${JSON.stringify(updated, null, 2)}\n`,
    {
      mode: 0o600,
      errorCode: "x_auth_persist_failed",
      commitAmbiguousErrorCode: "x_auth_persist_commit_ambiguous",
      errorLabel: "X OAuth credentials persistence"
    }
  );
}
