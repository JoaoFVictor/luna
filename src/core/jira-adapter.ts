import path from "node:path";
import { z } from "zod";
import { loadYamlFile, resolveConfigRoot } from "./config-loader.js";
import {
  jiraAuthForInstance,
  loadLunaAuth,
  type JiraAuth
} from "./jira-auth.js";
import {
  InvocationSchema,
  JiraConfigSchema,
  RepositoriesConfigSchema,
  type Invocation,
  type JiraConfig,
  type LunaAuthConfig,
  type RepositoryConfig,
  type RepositoriesConfig
} from "./types.js";

type JiraInstanceConfig = JiraConfig["instances"][number];

type JiraAdapterConfigs = {
  jira: JiraConfig;
  repositories: RepositoriesConfig;
};

export type JiraIssueRequest = {
  instance: JiraInstanceConfig;
  auth: JiraAuth;
  issueKey: string;
};

export type FetchJiraTaskInvocationOptions = {
  projectRoot?: string;
  configRoot?: string;
  loadConfigs?: () => Promise<JiraAdapterConfigs>;
  loadAuth?: () => Promise<LunaAuthConfig>;
  fetchIssue?: (request: JiraIssueRequest) => Promise<unknown>;
};

export type JiraAdapterError = Error & {
  code:
    | "invalid_jira_task_url"
    | "jira_instance_not_configured"
    | "jira_issue_fetch_failed"
    | "jira_issue_invalid_response"
    | "jira_repository_field_missing"
    | "jira_repository_field_invalid"
    | "repository_not_configured";
  cause?: unknown;
};

const JiraIssueSchema = z
  .object({
    key: z.string().min(1),
    fields: z.record(z.unknown())
  })
  .passthrough();

function adapterError(
  code: JiraAdapterError["code"],
  message: string,
  cause?: unknown
): JiraAdapterError {
  const error = new Error(message, { cause }) as JiraAdapterError;
  error.code = code;
  error.cause = cause;

  return error;
}

function parseJiraTaskUrl(url: string): { parsed: URL; issueKey: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw adapterError("invalid_jira_task_url", `Invalid Jira task URL: ${url}`, cause);
  }

  if (parsed.protocol !== "https:") {
    throw adapterError("invalid_jira_task_url", `Expected HTTPS Jira task URL: ${url}`);
  }

  const [browse, issueKey, ...extra] = parsed.pathname.split("/").filter(Boolean);
  if (
    browse !== "browse" ||
    issueKey === undefined ||
    extra.length > 0 ||
    !/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)
  ) {
    throw adapterError("invalid_jira_task_url", `Expected Jira browse URL: ${url}`);
  }

  return { parsed, issueKey };
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function findJiraInstance(
  jira: JiraConfig,
  url: URL
): JiraInstanceConfig {
  const instance = jira.instances.find(
    (candidate) => originOf(candidate.base_url) === url.origin
  );

  if (instance === undefined) {
    throw adapterError(
      "jira_instance_not_configured",
      `Jira instance is not configured for origin: ${url.origin}`
    );
  }

  return instance;
}

function textFromAdf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(textFromAdf).filter(Boolean).join(" ");
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const ownText = typeof record.text === "string" ? record.text : "";
    const contentText = textFromAdf(record.content);
    const combined = `${ownText}${contentText ? ` ${contentText}` : ""}`;

    return combined.trim();
  }

  return "";
}

function compactText(value: unknown): string {
  return textFromAdf(value).replace(/\s+/g, " ").trim();
}

function fieldName(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") {
      return record.name;
    }
  }

  return compactText(value);
}

function parseGithubFullName(value: unknown): { owner: string; name: string } {
  const fullName = compactText(value);
  if (fullName.length === 0) {
    throw adapterError(
      "jira_repository_field_missing",
      "Jira repository field is missing"
    );
  }

  const [owner, name, ...extra] = fullName.split("/");
  const safeSegment = /^[A-Za-z0-9_.-]+$/;
  if (
    owner === undefined ||
    name === undefined ||
    extra.length > 0 ||
    !safeSegment.test(owner) ||
    !safeSegment.test(name)
  ) {
    throw adapterError(
      "jira_repository_field_invalid",
      `Expected Jira repository field to be github_full_name: ${fullName}`
    );
  }

  return { owner, name };
}

function findRepository(
  repositories: readonly RepositoryConfig[],
  owner: string,
  name: string
): RepositoryConfig {
  const repository = repositories.find(
    (candidate) =>
      candidate.provider === "github" &&
      candidate.owner.toLowerCase() === owner.toLowerCase() &&
      candidate.name.toLowerCase() === name.toLowerCase()
  );

  if (repository === undefined) {
    throw adapterError(
      "repository_not_configured",
      `Repository is not configured: github/${owner}/${name}`
    );
  }

  return repository;
}

async function loadDefaultConfigs(
  configRoot: string
): Promise<JiraAdapterConfigs> {
  const [jira, repositories] = await Promise.all([
    loadYamlFile(path.join(configRoot, "jira.yaml"), JiraConfigSchema),
    loadYamlFile(path.join(configRoot, "repositories.yaml"), RepositoriesConfigSchema)
  ]);

  return { jira, repositories };
}

async function defaultFetchIssue({
  instance,
  auth,
  issueKey
}: JiraIssueRequest): Promise<unknown> {
  const url = new URL(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    instance.base_url
  );
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(
        `${auth.email}:${auth.api_token}`,
        "utf8"
      ).toString("base64")}`
    }
  });

  if (!response.ok) {
    throw adapterError(
      "jira_issue_fetch_failed",
      `Failed to fetch Jira issue ${issueKey}: HTTP ${response.status}`
    );
  }

  return await response.json();
}

export async function fetchJiraTaskInvocation(
  url: string,
  options: FetchJiraTaskInvocationOptions = {}
): Promise<Invocation> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const configRoot = options.configRoot ?? resolveConfigRoot();
  const { parsed, issueKey } = parseJiraTaskUrl(url);
  const configs = await (options.loadConfigs ??
    (() => loadDefaultConfigs(configRoot)))();
  const instance = findJiraInstance(configs.jira, parsed);
  const auth = jiraAuthForInstance(
    await (options.loadAuth ?? (() => loadLunaAuth(projectRoot)))(),
    instance.id
  );
  const fetchIssue = options.fetchIssue ?? defaultFetchIssue;
  const issueResponse = await fetchIssue({ instance, auth, issueKey });
  const parsedIssue = JiraIssueSchema.safeParse(issueResponse);

  if (!parsedIssue.success) {
    throw adapterError(
      "jira_issue_invalid_response",
      parsedIssue.error.message,
      parsedIssue.error
    );
  }

  const issue = parsedIssue.data;
  const fields = issue.fields;
  const repositoryField = fields[instance.repository_field.field_id];
  const { owner, name } = parseGithubFullName(repositoryField);
  findRepository(configs.repositories.repositories, owner, name);

  return InvocationSchema.parse({
    target: "jira_task",
    workflow: "implementation",
    jira: {
      instance_id: instance.id,
      issue_key: issue.key,
      url: parsed.toString(),
      summary: compactText(fields.summary),
      description: compactText(fields.description),
      acceptance_criteria: compactText(
        instance.acceptance_criteria_field === undefined
          ? ""
          : fields[instance.acceptance_criteria_field.field_id]
      ),
      status: fieldName(fields.status),
      issue_type: fieldName(fields.issuetype)
    },
    repository: {
      provider: "github",
      owner,
      name
    }
  });
}
