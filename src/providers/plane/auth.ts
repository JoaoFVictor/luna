import { z, ZodError } from "zod";
import {
  loadLunaAuthFile,
  lunaAuthError,
  type LunaAuthError
} from "../../core/auth/luna-auth-file.js";
import type { LunaAuthEnv } from "../../core/auth/root.js";

const NonEmptyStringSchema = z.string().min(1);

export const PlaneLunaAuthConfigSchema = z
  .object({
    providers: z
      .object({
        plane: z
          .record(
            z
              .object({
                base_url: NonEmptyStringSchema,
                auth_type: z.literal("api_key"),
                api_key: NonEmptyStringSchema
              })
              .strict()
          )
          .optional()
      })
      .catchall(z.unknown())
  })
  .strict();
export type PlaneLunaAuthConfig = z.infer<typeof PlaneLunaAuthConfigSchema>;

export type PlaneAuth = NonNullable<PlaneLunaAuthConfig["providers"]["plane"]>[string];

export type PlaneAuthError = (LunaAuthError | Error) & {
  code: "luna_auth_missing" | "luna_auth_invalid" | "plane_auth_missing";
  cause?: unknown;
};

function planeAuthError(
  code: PlaneAuthError["code"],
  message: string,
  cause?: unknown
): PlaneAuthError {
  if (code === "luna_auth_missing" || code === "luna_auth_invalid") {
    return lunaAuthError(code, message, cause) as PlaneAuthError;
  }

  const error = new Error(message, { cause }) as PlaneAuthError;
  error.code = code;
  error.cause = cause;

  return error;
}

export async function loadPlaneAuth(
  projectRoot = process.cwd(),
  env: LunaAuthEnv = process.env
): Promise<PlaneLunaAuthConfig> {
  const authFile = await loadLunaAuthFile(projectRoot, env);

  try {
    return PlaneLunaAuthConfigSchema.parse(authFile);
  } catch (cause) {
    if (cause instanceof ZodError) {
      throw planeAuthError(
        "luna_auth_invalid",
        "Luna auth Plane provider failed schema validation",
        cause
      );
    }

    throw cause;
  }
}

export function planeAuthForInstance(
  auth: PlaneLunaAuthConfig,
  instanceId: string
): PlaneAuth {
  const planeAuth = auth.providers.plane?.[instanceId];

  if (planeAuth === undefined) {
    throw planeAuthError(
      "plane_auth_missing",
      `Plane auth is not configured for instance: ${instanceId}`
    );
  }

  return planeAuth;
}

export function planeAuthForWorkspace(
  auth: PlaneLunaAuthConfig,
  baseUrl: string,
  workspaceSlug: string
): PlaneAuth {
  const authByWorkspace = auth.providers.plane?.[workspaceSlug];

  if (
    authByWorkspace !== undefined &&
    originOf(authByWorkspace.base_url) === originOf(baseUrl)
  ) {
    return authByWorkspace;
  }

  const matches = Object.values(auth.providers.plane ?? {}).filter(
    (candidate) => originOf(candidate.base_url) === originOf(baseUrl)
  );

  if (matches.length === 1) {
    return matches[0] as PlaneAuth;
  }

  throw planeAuthError(
    "plane_auth_missing",
    `Plane auth is not configured for workspace: ${workspaceSlug}`
  );
}

function originOf(url: string): string {
  return new URL(url).origin;
}
