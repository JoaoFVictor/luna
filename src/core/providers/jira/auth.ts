import { readFile } from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const LunaAuthConfigSchema = z
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
      .strict()
  })
  .strict();
export type LunaAuthConfig = z.infer<typeof LunaAuthConfigSchema>;

export type JiraAuth = NonNullable<LunaAuthConfig["providers"]["jira"]>[string];

export type LunaAuthError = Error & {
  code: "luna_auth_missing" | "luna_auth_invalid" | "jira_auth_missing";
  cause?: unknown;
};

function lunaAuthError(
  code: LunaAuthError["code"],
  message: string,
  cause?: unknown
): LunaAuthError {
  const error = new Error(message, { cause }) as LunaAuthError;
  error.code = code;
  error.cause = cause;

  return error;
}

export async function loadLunaAuth(
  projectRoot = process.cwd()
): Promise<LunaAuthConfig> {
  const authPath = path.join(projectRoot, "luna.auth.json");
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
    return LunaAuthConfigSchema.parse(parsed);
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

export function jiraAuthForInstance(
  auth: LunaAuthConfig,
  instanceId: string
): JiraAuth {
  const jiraAuth = auth.providers.jira?.[instanceId];

  if (jiraAuth === undefined) {
    throw lunaAuthError(
      "jira_auth_missing",
      `Jira auth is not configured for instance: ${instanceId}`
    );
  }

  return jiraAuth;
}
