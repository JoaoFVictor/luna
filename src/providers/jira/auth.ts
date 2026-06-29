import { z, ZodError } from "zod";
import {
  loadLunaAuthFile,
  lunaAuthError,
  type LunaAuthError
} from "../../core/auth/luna-auth-file.js";
import type { LunaAuthEnv } from "../../core/auth/root.js";

const NonEmptyStringSchema = z.string().min(1);

export const JiraLunaAuthConfigSchema = z
  .object({
    providers: z
      .object({
        jira: z
          .record(
            z
              .object({
                base_url: NonEmptyStringSchema,
                auth_type: z.literal("basic_api_token"),
                email: NonEmptyStringSchema,
                api_token: NonEmptyStringSchema
              })
              .strict()
          )
          .optional()
      })
      .catchall(z.unknown())
  })
  .strict();
export type JiraLunaAuthConfig = z.infer<typeof JiraLunaAuthConfigSchema>;

export type JiraAuth = NonNullable<JiraLunaAuthConfig["providers"]["jira"]>[string];

export type JiraAuthError = (LunaAuthError | Error) & {
  code: "luna_auth_missing" | "luna_auth_invalid" | "jira_auth_missing";
  cause?: unknown;
};

function jiraAuthError(
  code: JiraAuthError["code"],
  message: string,
  cause?: unknown
): JiraAuthError {
  if (code === "luna_auth_missing" || code === "luna_auth_invalid") {
    return lunaAuthError(code, message, cause) as JiraAuthError;
  }

  const error = new Error(message, { cause }) as JiraAuthError;
  error.code = code;
  error.cause = cause;

  return error;
}

export async function loadLunaAuth(
  projectRoot = process.cwd(),
  env: LunaAuthEnv = process.env
): Promise<JiraLunaAuthConfig> {
  const authFile = await loadLunaAuthFile(projectRoot, env);

  try {
    return JiraLunaAuthConfigSchema.parse(authFile);
  } catch (cause) {
    if (cause instanceof ZodError) {
      throw jiraAuthError(
        "luna_auth_invalid",
        "Luna auth Jira provider failed schema validation",
        cause
      );
    }

    throw cause;
  }
}

export function jiraAuthForInstance(
  auth: JiraLunaAuthConfig,
  instanceId: string
): JiraAuth {
  const jiraAuth = auth.providers.jira?.[instanceId];

  if (jiraAuth === undefined) {
    throw jiraAuthError(
      "jira_auth_missing",
      `Jira auth is not configured for instance: ${instanceId}`
    );
  }

  return jiraAuth;
}
